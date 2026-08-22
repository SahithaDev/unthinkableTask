const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Kolkata";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const sessions = new Map();
const slotLocks = new Set();
const googleOAuthStates = new Set();

const seed = {
  users: [
    {
      id: "u-admin",
      role: "admin",
      name: "Clinic Admin",
      email: "admin@clinic.test",
      password: "admin123",
    },
    {
      id: "u-doc-1",
      role: "doctor",
      name: "Dr. Maya Rao",
      email: "maya@clinic.test",
      password: "doctor123",
      doctorId: "doc-1",
    },
    {
      id: "u-patient-1",
      role: "patient",
      name: "Aarav Patient",
      email: "patient@clinic.test",
      password: "patient123",
    },
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
      leaveDays: [],
    },
  ],
  appointments: [],
  emailOutbox: [],
  calendarEvents: [],
  integrationTokens: {},
  medicationReminders: [],
};

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

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
    req.on("data", (chunk) => {
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
  return db.users.find((user) => user.id === userId) || null;
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
  if (doctor.leaveDays.includes(date))
    return { ok: false, reason: "Doctor is on leave that day" };
  if (
    minutes(time) < minutes(doctor.workingHours.start) ||
    minutes(time) >= minutes(doctor.workingHours.end)
  ) {
    return { ok: false, reason: "Slot is outside doctor working hours" };
  }
  const clash = db.appointments.find(
    (appointment) =>
      appointment.id !== excludeId &&
      appointment.doctorId === doctor.id &&
      appointment.startsAt === startsAt &&
      appointment.status !== "cancelled",
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
    status: hasEmailProvider() ? "queued" : "demo-queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
}

function hasEmailProvider() {
  return Boolean(process.env.BREVO_API_KEY || process.env.SENDGRID_API_KEY);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendBrevoEmail(mail) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: process.env.MAIL_FROM_NAME || "Healthcare Appointment Manager",
        email: process.env.MAIL_FROM,
      },
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.body,
      htmlContent: `<html><body><p>${escapeHtml(mail.body).replaceAll("\n", "<br>")}</p></body></html>`,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.message || data.error || "Brevo email failed");
  return data.messageId || "";
}

async function sendEmail(mail) {
  if (process.env.BREVO_API_KEY) return sendBrevoEmail(mail);
  throw new Error("No supported email provider configured. Add BREVO_API_KEY.");
}

function hasGoogleCalendarConfig() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI,
  );
}

function googleCalendarConnected(db) {
  return Boolean(
    db.integrationTokens?.google?.refresh_token ||
    db.integrationTokens?.google?.access_token,
  );
}

function addMinutesToLocalDateTime(localDateTime, durationMinutes) {
  const [date, time] = localDateTime.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const result = new Date(year, month - 1, day, hour, minute + durationMinutes);
  const adjusted = new Date(
    result.getTime() - result.getTimezoneOffset() * 60_000,
  );
  return adjusted.toISOString().slice(0, 16);
}

function calendarEventBody(appointment, doctor, patient) {
  const pre = appointment.preVisitSummary || {};
  const description = [
    `Patient: ${patient.name}`,
    `Doctor: ${doctor.name}`,
    `Symptoms: ${pre.cleanedSymptoms || appointment.symptoms}`,
    `Urgency: ${pre.urgency || "Not set"}`,
    pre.chiefComplaint ? `Chief complaint: ${pre.chiefComplaint}` : "",
    pre.suggestedQuestions?.length
      ? `Suggested questions: ${pre.suggestedQuestions.join(" | ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    summary: `Clinic appointment - ${patient.name} with ${doctor.name}`,
    description,
    start: { dateTime: `${appointment.startsAt}:00`, timeZone: APP_TIME_ZONE },
    end: {
      dateTime: `${addMinutesToLocalDateTime(appointment.startsAt, doctor.slotDuration)}:00`,
      timeZone: APP_TIME_ZONE,
    },
    attendees: [{ email: patient.email }, { email: doctor.email }],
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 24 * 60 },
        { method: "popup", minutes: 30 },
      ],
    },
  };
}

async function refreshGoogleAccessToken(db) {
  const google = db.integrationTokens?.google;
  if (!google?.refresh_token) return google?.access_token || "";
  if (
    google.access_token &&
    google.expires_at &&
    Date.now() < google.expires_at - 60_000
  ) {
    return google.access_token;
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: google.refresh_token,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error_description || data.error || "Google token refresh failed",
    );
  google.access_token = data.access_token;
  google.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000;
  return google.access_token;
}

async function insertGoogleCalendarEvent(
  db,
  event,
  appointment,
  doctor,
  patient,
) {
  const token = await refreshGoogleAccessToken(db);
  if (!token) throw new Error("Google Calendar is not connected");
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(calendarEventBody(appointment, doctor, patient)),
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message || "Google Calendar event creation failed",
    );
  event.googleEventId = data.id;
  event.htmlLink = data.htmlLink;
  event.status = "created";
}

async function createCalendarEvent(db, appointment, doctor, patient) {
  const event = {
    id: id("cal"),
    appointmentId: appointment.id,
    status:
      hasGoogleCalendarConfig() && googleCalendarConnected(db)
        ? "queued"
        : "demo-created",
    title: `Appointment with ${doctor.name}`,
    attendees: [doctor.email, patient.email],
    startsAt: appointment.startsAt,
    durationMinutes: doctor.slotDuration,
  };
  db.calendarEvents.push(event);
  appointment.calendarEventId = event.id;
  if (event.status === "queued") {
    try {
      await insertGoogleCalendarEvent(db, event, appointment, doctor, patient);
    } catch (error) {
      event.status = "failed";
      event.error = error.message;
    }
  }
}

function fallbackPreVisitSummary(symptoms) {
  const urgentWords = [
    "chest pain",
    "faint",
    "breath",
    "severe",
    "bleeding",
    "stroke",
  ];
  const text = symptoms.toLowerCase();
  const urgency = urgentWords.some((word) => text.includes(word))
    ? "High"
    : symptoms.length > 140
      ? "Medium"
      : "Low";
  return {
    urgency,
    chiefComplaint: symptoms.slice(0, 180),
    suggestedQuestions: [
      "When did the symptoms start and what changed recently?",
      "What makes the symptoms better or worse?",
      "Are there related medicines, allergies, or prior conditions?",
    ],
    source: "fallback",
  };
}

function fallbackPostVisitSummary(notes, prescription) {
  const schedule =
    prescription || "Follow the doctor's prescription instructions.";
  return {
    summary: `Your visit notes were reviewed. ${notes.slice(0, 240)}`,
    medicationSchedule: schedule,
    followUpSteps:
      "Book follow-up if symptoms worsen or if the doctor requested a review.",
    source: "fallback",
  };
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object returned");
    return JSON.parse(match[0]);
  }
}

async function generateWithGemini(prompt) {
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key is not configured");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message || "Gemini request failed");
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";
  if (!text) throw new Error("Gemini returned an empty response");
  return extractJson(text);
}

async function preVisitSummary(symptoms) {
  const fallback = fallbackPreVisitSummary(symptoms);
  try {
    const result = await generateWithGemini(`
You are a clinical triage assistant helping a doctor prepare before seeing a patient.

Your tasks:
1. Correct spelling and grammar in the patient's symptom description. Do NOT add, remove, or invent any symptoms.
2. Write a single clear chief complaint sentence summarising what the patient reported.
3. Assign an urgency level:
   - High: any chest pain, difficulty breathing, severe pain, fainting, stroke signs, heavy bleeding, or anything life-threatening
   - Medium: symptoms lasting more than 3 days, high fever, moderate pain, or worsening conditions
   - Low: mild or short-duration symptoms with no red flags
4. Write three focused questions the doctor should ask this specific patient to clarify their condition. Make them relevant to the reported symptoms — do not use generic filler questions.

Return ONLY valid JSON with exactly this shape, no extra text:
{
  "urgency": "Low | Medium | High",
  "chiefComplaint": "one clean sentence summarising the complaint",
  "cleanedSymptoms": "corrected and readable version of the patient's own words",
  "suggestedQuestions": ["specific question 1", "specific question 2", "specific question 3"]
}

Patient symptoms: ${symptoms}
`);
    return {
      urgency: ["Low", "Medium", "High"].includes(result.urgency)
        ? result.urgency
        : fallback.urgency,
      chiefComplaint: result.chiefComplaint || fallback.chiefComplaint,
      cleanedSymptoms: result.cleanedSymptoms || symptoms,
      suggestedQuestions: Array.isArray(result.suggestedQuestions)
        ? result.suggestedQuestions.slice(0, 3)
        : fallback.suggestedQuestions,
      source: "gemini",
    };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

async function postVisitSummary(notes, prescription) {
  const fallback = fallbackPostVisitSummary(notes, prescription);
  try {
    const result = await generateWithGemini(`
You are a medical communication specialist converting a doctor's clinical notes into a clear, friendly summary for the patient.

Your tasks:
1. Write a patient-friendly visit summary in plain language. Avoid medical jargon. If jargon must be used, briefly explain it.
2. Write a clear medication schedule listing each medicine, its dose, frequency, and duration exactly as prescribed. If no prescription was given, say "No medication prescribed."
3. Write specific follow-up steps the patient should take — include when to return, warning signs to watch for, and any lifestyle advice mentioned in the notes.

Rules:
- Do NOT add any medical advice, diagnoses, or facts that are not present in the notes.
- Keep the tone warm, simple, and reassuring.
- Write for someone with no medical background.

Return ONLY valid JSON with exactly this shape, no extra text:
{
  "summary": "plain-language visit summary for the patient",
  "medicationSchedule": "each medicine with dose, frequency, and duration",
  "followUpSteps": "specific next steps and warning signs to watch for"
}

Clinical notes: ${notes}
Prescription: ${prescription || "No prescription entered"}
`);
    return {
      summary: result.summary || fallback.summary,
      medicationSchedule:
        result.medicationSchedule || fallback.medicationSchedule,
      followUpSteps: result.followUpSteps || fallback.followUpSteps,
      source: "gemini",
    };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

function createMedicationReminder(db, appointment, prescription) {
  if (!prescription) return;
  db.medicationReminders.push({
    id: id("reminder"),
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    prescription,
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: "scheduled",
  });
}

function routeStatic(req, res) {
  const requested =
    req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
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
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = req.method === "GET" ? {} : await parseBody(req);

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const user = db.users.find(
      (item) => item.email === body.email && item.password === body.password,
    );
    if (!user) return json(res, 401, { error: "Invalid email or password" });
    const token = id("session");
    sessions.set(token, user.id);
    return json(res, 200, { token, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    if (!body.name || !body.email || !body.password)
      return json(res, 400, {
        error: "Name, email, and password are required",
      });
    if (db.users.some((user) => user.email === body.email))
      return json(res, 409, { error: "Email already registered" });
    const user = {
      id: id("u"),
      role: "patient",
      name: body.name,
      email: body.email,
      password: body.password,
    };
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
    const specialisation = (
      url.searchParams.get("specialisation") || ""
    ).toLowerCase();
    const doctors = db.doctors.filter(
      (doctor) =>
        !specialisation ||
        doctor.specialisation.toLowerCase().includes(specialisation),
    );
    return json(res, 200, { doctors });
  }

  if (req.method === "POST" && url.pathname === "/api/appointments") {
    const user = requireRole(req, res, db, ["patient"]);
    if (!user) return;
    const doctor = db.doctors.find((item) => item.id === body.doctorId);
    if (!doctor) return json(res, 404, { error: "Doctor not found" });
    if (!body.startsAt || !body.symptoms)
      return json(res, 400, { error: "Slot and symptoms are required" });
    const key = slotKey(doctor.id, body.startsAt);
    if (slotLocks.has(key))
      return json(res, 409, {
        error:
          "Another booking is being confirmed for this slot. Please retry.",
      });
    slotLocks.add(key);
    try {
      const availability = isSlotAvailable(db, doctor, body.startsAt);
      if (!availability.ok)
        return json(res, 409, { error: availability.reason });
      const appointment = {
        id: id("appt"),
        doctorId: doctor.id,
        patientId: user.id,
        startsAt: body.startsAt,
        symptoms: body.symptoms,
        status: "booked",
        preVisitSummary: await preVisitSummary(body.symptoms),
        postVisitSummary: null,
        prescription: "",
        createdAt: new Date().toISOString(),
      };
      db.appointments.push(appointment);
      await createCalendarEvent(db, appointment, doctor, user);
      enqueueEmail(
        db,
        user.email,
        "Appointment confirmed",
        `Your appointment with ${doctor.name} is confirmed for ${body.startsAt}. A calendar invitation will be sent if Google Calendar is connected.`,
      );
      enqueueEmail(
        db,
        doctor.email,
        "New patient appointment",
        [
          `${user.name} booked ${body.startsAt}.`,
          `Urgency: ${appointment.preVisitSummary.urgency}.`,
          `Chief complaint: ${appointment.preVisitSummary.chiefComplaint}.`,
          `Cleaned symptoms: ${appointment.preVisitSummary.cleanedSymptoms || appointment.symptoms}.`,
          `Suggested questions: ${(appointment.preVisitSummary.suggestedQuestions || []).join(" ")}`,
        ].join("\n"),
      );
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
    if (user.role === "patient")
      appointments = appointments.filter((item) => item.patientId === user.id);
    if (user.role === "doctor") {
      const doctor = db.doctors.find((item) => item.id === user.doctorId);
      appointments = appointments.filter(
        (item) => item.doctorId === doctor?.id,
      );
    }
    const enriched = appointments.map((appointment) => ({
      ...appointment,
      doctor: db.doctors.find((doctor) => doctor.id === appointment.doctorId),
      patient: publicUser(
        db.users.find((patient) => patient.id === appointment.patientId) || {},
      ),
    }));
    return json(res, 200, { appointments: enriched });
  }

  if (
    req.method === "PATCH" &&
    url.pathname.startsWith("/api/appointments/") &&
    url.pathname.endsWith("/cancel")
  ) {
    const user = requireRole(req, res, db, ["patient", "admin"]);
    if (!user) return;
    const appointment = db.appointments.find(
      (item) => item.id === url.pathname.split("/")[3],
    );
    if (!appointment) return json(res, 404, { error: "Appointment not found" });
    if (user.role === "patient" && appointment.patientId !== user.id)
      return json(res, 403, {
        error: "Cannot cancel another patient's appointment",
      });
    appointment.status = "cancelled";
    const patient = db.users.find((item) => item.id === appointment.patientId);
    const doctor = db.doctors.find((item) => item.id === appointment.doctorId);
    enqueueEmail(
      db,
      patient.email,
      "Appointment cancelled",
      `Your appointment for ${appointment.startsAt} was cancelled.`,
    );
    enqueueEmail(
      db,
      doctor.email,
      "Appointment cancelled",
      `${patient.name}'s appointment for ${appointment.startsAt} was cancelled.`,
    );
    const cal = db.calendarEvents.find(
      (item) => item.appointmentId === appointment.id,
    );
    if (cal) cal.status = "delete-queued";
    writeDb(db);
    return json(res, 200, { appointment });
  }

  if (
    req.method === "PATCH" &&
    url.pathname.startsWith("/api/appointments/") &&
    url.pathname.endsWith("/visit")
  ) {
    const user = requireRole(req, res, db, ["doctor"]);
    if (!user) return;
    const doctor = db.doctors.find((item) => item.id === user.doctorId);
    const appointment = db.appointments.find(
      (item) =>
        item.id === url.pathname.split("/")[3] && item.doctorId === doctor.id,
    );
    if (!appointment) return json(res, 404, { error: "Appointment not found" });
    appointment.status = "completed";
    appointment.clinicalNotes = body.notes || "";
    appointment.prescription = body.prescription || "";
    appointment.postVisitSummary = await postVisitSummary(
      appointment.clinicalNotes,
      appointment.prescription,
    );
    createMedicationReminder(db, appointment, appointment.prescription);
    const patient = db.users.find((item) => item.id === appointment.patientId);
    enqueueEmail(
      db,
      patient.email,
      "Visit summary available",
      appointment.postVisitSummary.summary,
    );
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
      password: body.password || "doctor123",
    };
    const doctor = {
      id: id("doc"),
      userId: doctorUser.id,
      name: body.name,
      email: body.email,
      specialisation: body.specialisation,
      workingHours: body.workingHours || { start: "09:00", end: "17:00" },
      slotDuration: Number(body.slotDuration || 30),
      leaveDays: [],
    };
    doctorUser.doctorId = doctor.id;
    db.users.push(doctorUser);
    db.doctors.push(doctor);
    writeDb(db);
    return json(res, 201, { doctor });
  }

  if (
    req.method === "PATCH" &&
    url.pathname.startsWith("/api/admin/doctors/") &&
    url.pathname.endsWith("/leave")
  ) {
    const user = requireRole(req, res, db, ["admin"]);
    if (!user) return;
    const doctor = db.doctors.find(
      (item) => item.id === url.pathname.split("/")[4],
    );
    if (!doctor) return json(res, 404, { error: "Doctor not found" });
    if (!body.date) return json(res, 400, { error: "Leave date is required" });
    if (!doctor.leaveDays.includes(body.date)) doctor.leaveDays.push(body.date);
    const affected = db.appointments.filter(
      (item) =>
        item.doctorId === doctor.id &&
        sameDate(item.startsAt, body.date) &&
        item.status === "booked",
    );
    for (const appointment of affected) {
      appointment.status = "cancelled";
      appointment.cancelReason = "Doctor leave";
      const patient = db.users.find(
        (item) => item.id === appointment.patientId,
      );
      enqueueEmail(
        db,
        patient.email,
        "Appointment cancelled due to doctor leave",
        `${doctor.name} is unavailable on ${body.date}. Please book another slot.`,
      );
      const cal = db.calendarEvents.find(
        (item) => item.appointmentId === appointment.id,
      );
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
      medicationReminders: db.medicationReminders,
      integrations: {
        gemini: Boolean(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY),
        brevo: Boolean(process.env.BREVO_API_KEY),
        googleCalendarConfigured: hasGoogleCalendarConfig(),
        googleCalendarConnected: googleCalendarConnected(db),
      },
    });
  }

  json(res, 404, { error: "API route not found" });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function htmlError(res, status, title, message) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:40px auto;line-height:1.5">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>Redirect URI this app uses:</p>
    <pre>${escapeHtml(process.env.GOOGLE_REDIRECT_URI || "(missing)")}</pre>
    <p>That exact URI must be listed under Authorized redirect URIs on a <strong>Web application</strong> OAuth client. Then restart the server and open <a href="/oauth/google/start">/oauth/google/start</a> again. Do not refresh a failed callback URL.</p>
  </body></html>`);
}

function ensureIntegrationTokens(db) {
  if (!db.integrationTokens || Array.isArray(db.integrationTokens)) {
    db.integrationTokens = {};
  }
  return db.integrationTokens;
}

async function handleGoogleOAuth(req, res) {
  try {
    const db = readDb();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (!hasGoogleCalendarConfig()) {
      return htmlError(
        res,
        500,
        "Google Calendar is not configured",
        "Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to .env, then restart the app.",
      );
    }

    if (url.pathname === "/oauth/google/start") {
      const state = id("oauth");
      googleOAuthStates.add(state);
      const tokens = ensureIntegrationTokens(db);
      tokens.googleOAuthState = state;
      writeDb(db);
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        response_type: "code",
        scope:
          "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });

      // redirect(
      //   res,
      //   `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      // );
      console.log("CLIENT_ID:", process.env.GOOGLE_CLIENT_ID);
      console.log("REDIRECT_URI:", process.env.GOOGLE_REDIRECT_URI);

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

      console.log("CLIENT_ID:", process.env.GOOGLE_CLIENT_ID);
      console.log("REDIRECT_URI:", process.env.GOOGLE_REDIRECT_URI);
      console.log("AUTH URL:", authUrl);

      redirect(res, authUrl);
      return;
    }

    if (url.pathname === "/oauth/google/callback") {
      const expectedState = ensureIntegrationTokens(db).googleOAuthState;
      const receivedState = url.searchParams.get("state");
      const stateOk =
        receivedState &&
        (googleOAuthStates.has(receivedState) ||
          receivedState === expectedState);
      if (!stateOk) {
        return htmlError(
          res,
          400,
          "Google OAuth state mismatch",
          "Start over from /oauth/google/start instead of reusing an old login tab.",
        );
      }
      googleOAuthStates.delete(receivedState);
      const code = url.searchParams.get("code");
      if (!code) {
        const googleError =
          url.searchParams.get("error_description") ||
          url.searchParams.get("error") ||
          "Missing code";
        return htmlError(res, 400, "Google OAuth failed", googleError);
      }
      console.log("CLIENT_ID =", process.env.GOOGLE_CLIENT_ID);
      console.log("REDIRECT_URI =", process.env.GOOGLE_REDIRECT_URI);
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      });
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
      const raw = await response.text();
      let tokens = {};
      try {
        tokens = JSON.parse(raw);
      } catch {
        return htmlError(
          res,
          500,
          "Google token exchange failed",
          `Google returned a non-JSON response (${response.status}): ${raw.slice(0, 300)}`,
        );
      }
      if (!response.ok) {
        console.error(
          "Google token exchange failed",
          response.status,
          tokens.error,
          tokens.error_description,
        );
        return htmlError(
          res,
          500,
          "Google token exchange failed",
          tokens.error_description || tokens.error || `HTTP ${response.status}`,
        );
      }
      const tokensStore = ensureIntegrationTokens(db);
      tokensStore.google = {
        access_token: tokens.access_token,
        refresh_token:
          tokens.refresh_token || tokensStore.google?.refresh_token,
        expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        scope: tokens.scope,
        connectedAt: new Date().toISOString(),
      };
      delete tokensStore.googleOAuthState;
      writeDb(db);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:40px auto"><h1>Google Calendar connected</h1><p>You can close this tab and book a new appointment. Calendar events will be created on this Google account and invitations will go to the patient and doctor emails.</p></body></html>',
      );
      return;
    }

    htmlError(res, 404, "Unknown Google OAuth route", url.pathname);
  } catch (error) {
    console.error("Google OAuth handler error", error);
    htmlError(
      res,
      500,
      "Google OAuth crashed",
      error.message || "Unknown error",
    );
  }
}

async function runBackgroundJobs() {
  const db = readDb();
  const now = new Date();
  for (const mail of db.emailOutbox.filter(
    (item) => item.status.endsWith("queued") && item.attempts < 3,
  )) {
    mail.attempts += 1;
    mail.lastAttemptAt = now.toISOString();
    if (mail.status === "demo-queued") {
      mail.status = "demo-sent";
      continue;
    }
    try {
      mail.providerMessageId = await sendEmail(mail);
      mail.status = "sent";
      delete mail.error;
    } catch (error) {
      mail.status = mail.attempts >= 3 ? "failed" : "queued";
      mail.error = error.message;
    }
    writeDb(db);
  }
  for (const reminder of db.medicationReminders.filter(
    (item) => item.status === "scheduled" && new Date(item.nextRunAt) <= now,
  )) {
    const patient = db.users.find((item) => item.id === reminder.patientId);
    enqueueEmail(
      db,
      patient.email,
      "Medication reminder",
      reminder.prescription,
    );
    reminder.nextRunAt = new Date(
      Date.now() + 12 * 60 * 60 * 1000,
    ).toISOString();
  }
  writeDb(db);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/oauth/google/"))
      return await handleGoogleOAuth(req, res);
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    routeStatic(req, res);
  } catch (error) {
    json(res, 500, { error: "Something went wrong", detail: error.message });
  }
});

ensureDb();
setInterval(
  () => runBackgroundJobs().catch((error) => console.error(error)),
  60_000,
);
server.listen(PORT, () => {
  console.log(
    `Healthcare Appointment Manager running at http://localhost:${PORT}`,
  );
  if (hasGoogleCalendarConfig()) {
    console.log(
      `Connect Google Calendar at ${APP_BASE_URL}/oauth/google/start`,
    );
  }
});
