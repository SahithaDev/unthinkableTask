const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const sessions = new Map();
const slotLocks = new Set();

const seed = {
  users: [
    { id: "u-admin", role: "admin", name: "Clinic Admin", email: "admin@clinic.test", password: "admin123" },
    { id: "u-doc-1", role: "doctor", name: "Dr. Maya Rao", email: "maya@clinic.test", password: "doctor123", doctorId: "doc-1" },
    { id: "u-patient-1", role: "patient", name: "Aarav Patient", email: "patient@clinic.test", password: "patient123" }
  ],
  doctors: [
    {
      id: "doc-1",
      userId: "u-doc-1",
      name: "Dr. Maya Rao",
      email: "maya@clinic.test",
      specialisation: "Cardiology",
      workingHours: { start: "09:00", end: "17:00" },
      slotDuration: 30,
      leaveDays: []
    }
  ],
  appointments: [],
  emailOutbox: [],
  calendarEvents: [],
  medicationReminders: []
};

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(DB_FILE)) writeDb(seed);
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function currentUser(req, db) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const userId = sessions.get(token);
  return db.users.find(user => user.id === userId) || null;
}

function requireRole(req, res, db, roles) {
  const user = currentUser(req, db);
  if (!user) {
    json(res, 401, { error: "Login required" });
    return null;
  }
  if (!roles.includes(user.role)) {
    json(res, 403, { error: "You do not have access to this action" });
    return null;
  }
  return user;
}

function publicUser(user) {
  const { password, ...safe } = user;
  return safe;
}

function minutes(time) {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

function sameDate(iso, date) {
  return iso.slice(0, 10) === date;
}

function slotKey(doctorId, startsAt) {
  return `${doctorId}:${startsAt}`;
}

function isSlotAvailable(db, doctor, startsAt, excludeId) {
  const date = startsAt.slice(0, 10);
  const time = startsAt.slice(11, 16);
  if (doctor.leaveDays.includes(date)) return { ok: false, reason: "Doctor is on leave that day" };
  if (minutes(time) < minutes(doctor.workingHours.start) || minutes(time) >= minutes(doctor.workingHours.end)) {
    return { ok: false, reason: "Slot is outside doctor working hours" };
  }
  const clash = db.appointments.find(appointment =>
    appointment.id !== excludeId &&
    appointment.doctorId === doctor.id &&
    appointment.startsAt === startsAt &&
    appointment.status !== "cancelled"
  );
  if (clash) return { ok: false, reason: "Slot is already booked" };
  return { ok: true };
}

function enqueueEmail(db, to, subject, body) {
  db.emailOutbox.push({
    id: id("mail"),
    to,
    subject,
    body,
    status: process.env.SENDGRID_API_KEY ? "queued" : "demo-queued",
    attempts: 0,
    createdAt: new Date().toISOString()
  });
}

function createCalendarEvent(db, appointment, doctor, patient) {
  const event = {
    id: id("cal"),
    appointmentId: appointment.id,
    status: process.env.GOOGLE_CLIENT_ID ? "queued" : "demo-created",
    title: `Appointment with ${doctor.name}`,
    attendees: [doctor.email, patient.email],
    startsAt: appointment.startsAt,
    durationMinutes: doctor.slotDuration
  };
  db.calendarEvents.push(event);
  appointment.calendarEventId = event.id;
}

function preVisitSummary(symptoms) {
  const urgentWords = ["chest pain", "faint", "breath", "severe", "bleeding", "stroke"];
  const text = symptoms.toLowerCase();
  const urgency = urgentWords.some(word => text.includes(word)) ? "High" : symptoms.length > 140 ? "Medium" : "Low";
  return {
    urgency,
    chiefComplaint: symptoms.slice(0, 180),
    suggestedQuestions: [
      "When did the symptoms start and what changed recently?",
      "What makes the symptoms better or worse?",
      "Are there related medicines, allergies, or prior conditions?"
    ],
    source: process.env.LLM_API_KEY ? "llm-ready" : "fallback"
  };
}

function postVisitSummary(notes, prescription) {
  const schedule = prescription || "Follow the doctor's prescription instructions.";
  return {
    summary: `Your visit notes were reviewed. ${notes.slice(0, 240)}`,
    medicationSchedule: schedule,
    followUpSteps: "Book follow-up if symptoms worsen or if the doctor requested a review.",
    source: process.env.LLM_API_KEY ? "llm-ready" : "fallback"
  };
}

function createMedicationReminder(db, appointment, prescription) {
  if (!prescription) return;
  db.medicationReminders.push({
    id: id("reminder"),
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    prescription,
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: "scheduled"
  });
}

function routeStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
  res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = req.method === "GET" ? {} : await parseBody(req);

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const user = db.users.find(item => item.email === body.email && item.password === body.password);
    if (!user) return json(res, 401, { error: "Invalid email or password" });
    const token = id("session");
    sessions.set(token, user.id);
    return json(res, 200, { token, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    if (!body.name || !body.email || !body.password) return json(res, 400, { error: "Name, email, and password are required" });
    if (db.users.some(user => user.email === body.email)) return json(res, 409, { error: "Email already registered" });
    const user = { id: id("u"), role: "patient", name: body.name, email: body.email, password: body.password };
    db.users.push(user);
    writeDb(db);
    return json(res, 201, { user: publicUser(user) });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = requireRole(req, res, db, ["patient", "doctor", "admin"]);
    if (!user) return;
    return json(res, 200, { user: publicUser(user) });
  }

  if (req.method === "GET" && url.pathname === "/api/doctors") {
    const specialisation = (url.searchParams.get("specialisation") || "").toLowerCase();
    const doctors = db.doctors.filter(doctor => !specialisation || doctor.specialisation.toLowerCase().includes(specialisation));
    return json(res, 200, { doctors });
  }

  if (req.method === "POST" && url.pathname === "/api/appointments") {
    const user = requireRole(req, res, db, ["patient"]);
    if (!user) return;
    const doctor = db.doctors.find(item => item.id === body.doctorId);
    if (!doctor) return json(res, 404, { error: "Doctor not found" });
    if (!body.startsAt || !body.symptoms) return json(res, 400, { error: "Slot and symptoms are required" });
    const key = slotKey(doctor.id, body.startsAt);
    if (slotLocks.has(key)) return json(res, 409, { error: "Another booking is being confirmed for this slot. Please retry." });
    slotLocks.add(key);
    try {
      const availability = isSlotAvailable(db, doctor, body.startsAt);
      if (!availability.ok) return json(res, 409, { error: availability.reason });
      const appointment = {
        id: id("appt"),
        doctorId: doctor.id,
        patientId: user.id,
        startsAt: body.startsAt,
        symptoms: body.symptoms,
        status: "booked",
        preVisitSummary: preVisitSummary(body.symptoms),
        postVisitSummary: null,
        prescription: "",
        createdAt: new Date().toISOString()
      };
      db.appointments.push(appointment);
      createCalendarEvent(db, appointment, doctor, user);
      enqueueEmail(db, user.email, "Appointment confirmed", `Your appointment with ${doctor.name} is confirmed for ${body.startsAt}.`);
      enqueueEmail(db, doctor.email, "New patient appointment", `${user.name} booked ${body.startsAt}. Urgency: ${appointment.preVisitSummary.urgency}.`);
      writeDb(db);
      return json(res, 201, { appointment });
    } finally {
      slotLocks.delete(key);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/appointments") {
    const user = requireRole(req, res, db, ["patient", "doctor", "admin"]);
    if (!user) return;
    let appointments = db.appointments;
    if (user.role === "patient") appointments = appointments.filter(item => item.patientId === user.id);
    if (user.role === "doctor") {
      const doctor = db.doctors.find(item => item.id === user.doctorId);
      appointments = appointments.filter(item => item.doctorId === doctor?.id);
    }
    const enriched = appointments.map(appointment => ({
      ...appointment,
      doctor: db.doctors.find(doctor => doctor.id === appointment.doctorId),
      patient: publicUser(db.users.find(patient => patient.id === appointment.patientId) || {})
    }));
    return json(res, 200, { appointments: enriched });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/appointments/") && url.pathname.endsWith("/cancel")) {
    const user = requireRole(req, res, db, ["patient", "admin"]);
    if (!user) return;
    const appointment = db.appointments.find(item => item.id === url.pathname.split("/")[3]);
    if (!appointment) return json(res, 404, { error: "Appointment not found" });
    if (user.role === "patient" && appointment.patientId !== user.id) return json(res, 403, { error: "Cannot cancel another patient's appointment" });
    appointment.status = "cancelled";
    const patient = db.users.find(item => item.id === appointment.patientId);
    const doctor = db.doctors.find(item => item.id === appointment.doctorId);
    enqueueEmail(db, patient.email, "Appointment cancelled", `Your appointment for ${appointment.startsAt} was cancelled.`);
    enqueueEmail(db, doctor.email, "Appointment cancelled", `${patient.name}'s appointment for ${appointment.startsAt} was cancelled.`);
    const cal = db.calendarEvents.find(item => item.appointmentId === appointment.id);
    if (cal) cal.status = "delete-queued";
    writeDb(db);
    return json(res, 200, { appointment });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/appointments/") && url.pathname.endsWith("/visit")) {
    const user = requireRole(req, res, db, ["doctor"]);
    if (!user) return;
    const doctor = db.doctors.find(item => item.id === user.doctorId);
    const appointment = db.appointments.find(item => item.id === url.pathname.split("/")[3] && item.doctorId === doctor.id);
    if (!appointment) return json(res, 404, { error: "Appointment not found" });
    appointment.status = "completed";
    appointment.clinicalNotes = body.notes || "";
    appointment.prescription = body.prescription || "";
    appointment.postVisitSummary = postVisitSummary(appointment.clinicalNotes, appointment.prescription);
    createMedicationReminder(db, appointment, appointment.prescription);
    const patient = db.users.find(item => item.id === appointment.patientId);
    enqueueEmail(db, patient.email, "Visit summary available", appointment.postVisitSummary.summary);
    writeDb(db);
    return json(res, 200, { appointment });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/doctors") {
    const user = requireRole(req, res, db, ["admin"]);
    if (!user) return;
    const doctorUser = {
      id: id("u"),
      role: "doctor",
      name: body.name,
      email: body.email,
      password: body.password || "doctor123"
    };
    const doctor = {
      id: id("doc"),
      userId: doctorUser.id,
      name: body.name,
      email: body.email,
      specialisation: body.specialisation,
      workingHours: body.workingHours || { start: "09:00", end: "17:00" },
      slotDuration: Number(body.slotDuration || 30),
      leaveDays: []
    };
    doctorUser.doctorId = doctor.id;
    db.users.push(doctorUser);
    db.doctors.push(doctor);
    writeDb(db);
    return json(res, 201, { doctor });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/doctors/") && url.pathname.endsWith("/leave")) {
    const user = requireRole(req, res, db, ["admin"]);
    if (!user) return;
    const doctor = db.doctors.find(item => item.id === url.pathname.split("/")[4]);
    if (!doctor) return json(res, 404, { error: "Doctor not found" });
    if (!body.date) return json(res, 400, { error: "Leave date is required" });
    if (!doctor.leaveDays.includes(body.date)) doctor.leaveDays.push(body.date);
    const affected = db.appointments.filter(item => item.doctorId === doctor.id && sameDate(item.startsAt, body.date) && item.status === "booked");
    for (const appointment of affected) {
      appointment.status = "cancelled";
      appointment.cancelReason = "Doctor leave";
      const patient = db.users.find(item => item.id === appointment.patientId);
      enqueueEmail(db, patient.email, "Appointment cancelled due to doctor leave", `${doctor.name} is unavailable on ${body.date}. Please book another slot.`);
      const cal = db.calendarEvents.find(item => item.appointmentId === appointment.id);
      if (cal) cal.status = "delete-queued";
    }
    writeDb(db);
    return json(res, 200, { doctor, affectedAppointments: affected.length });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/ops") {
    const user = requireRole(req, res, db, ["admin"]);
    if (!user) return;
    return json(res, 200, {
      emailOutbox: db.emailOutbox,
      calendarEvents: db.calendarEvents,
      medicationReminders: db.medicationReminders
    });
  }

  json(res, 404, { error: "API route not found" });
}

function runBackgroundJobs() {
  const db = readDb();
  const now = new Date();
  for (const mail of db.emailOutbox.filter(item => item.status.endsWith("queued") && item.attempts < 3)) {
    mail.attempts += 1;
    mail.status = process.env.SENDGRID_API_KEY ? "sent" : "demo-sent";
    mail.lastAttemptAt = now.toISOString();
  }
  for (const reminder of db.medicationReminders.filter(item => item.status === "scheduled" && new Date(item.nextRunAt) <= now)) {
    const patient = db.users.find(item => item.id === reminder.patientId);
    enqueueEmail(db, patient.email, "Medication reminder", reminder.prescription);
    reminder.nextRunAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  }
  writeDb(db);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    routeStatic(req, res);
  } catch (error) {
    json(res, 500, { error: "Something went wrong", detail: error.message });
  }
});

ensureDb();
setInterval(runBackgroundJobs, 60_000);
server.listen(PORT, () => {
  console.log(`Healthcare Appointment Manager running at http://localhost:${PORT}`);
});

