const state = {
  token: localStorage.getItem("token") || "",
  user: JSON.parse(localStorage.getItem("user") || "null"),
  doctors: []
};

function $(selector) {
  return document.querySelector(selector);
}

function status(selector, message, ok = false) {
  const el = $(selector);
  if (!el) return;
  el.textContent = message || "";
  el.className = ok ? "status success" : "status";
}

function selectedDoctor() {
  const doctorId = $("#doctorId")?.value;
  return state.doctors.find(doctor => doctor.id === doctorId);
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function setMinimumAppointmentTime() {
  const input = $("#startsAt");
  if (!input) return;
  const now = new Date();
  now.setMinutes(now.getMinutes() + 15);
  now.setSeconds(0, 0);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  input.min = local.toISOString().slice(0, 16);
}

function renderSelectedDoctorHelp() {
  const help = $("#doctor-help");
  if (!help) return;
  const doctor = selectedDoctor();
  if (!doctor) {
    help.textContent = "Select a doctor to see availability.";
    return;
  }
  help.textContent = `${doctor.name} is available ${doctor.workingHours.start}-${doctor.workingHours.end}. Leave days: ${doctor.leaveDays.join(", ") || "None"}.`;
}

function validateBookingForm() {
  const doctor = selectedDoctor();
  const startsAt = $("#startsAt")?.value;
  const symptoms = $("#symptoms")?.value.trim();
  if (!doctor) return "Please select a doctor.";
  if (!startsAt) return "Please select appointment date and time.";
  if (!symptoms) return "Please describe the symptoms before confirming.";

  const appointmentDate = startsAt.slice(0, 10);
  const appointmentTime = startsAt.slice(11, 16);
  if (doctor.leaveDays.includes(appointmentDate)) {
    return `${doctor.name} is on leave on ${appointmentDate}. Please choose another date or doctor.`;
  }
  const time = timeToMinutes(appointmentTime);
  if (time < timeToMinutes(doctor.workingHours.start) || time >= timeToMinutes(doctor.workingHours.end)) {
    return `Please choose a time between ${doctor.workingHours.start} and ${doctor.workingHours.end}.`;
  }
  return "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function login(role) {
  try {
    status(`#${role}-status`, "");
    const email = $(`#${role}-email`).value;
    const password = $(`#${role}-password`).value;
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    if (data.user.role !== role) throw new Error(`This page is for ${role} users.`);
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("token", state.token);
    localStorage.setItem("user", JSON.stringify(state.user));
    location.reload();
  } catch (error) {
    status(`#${role}-status`, error.message);
  }
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  location.reload();
}

function ensureRole(role) {
  if (!state.user || state.user.role !== role) {
    $(".private")?.setAttribute("hidden", "hidden");
    $(".auth")?.removeAttribute("hidden");
    return false;
  }
  $(".auth")?.setAttribute("hidden", "hidden");
  $(".private")?.removeAttribute("hidden");
  const userName = $(".user-name");
  if (userName) userName.textContent = state.user.name;
  return true;
}

function resetSession(message = "Please sign in again.") {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  state.token = "";
  state.user = null;
  $(".private")?.setAttribute("hidden", "hidden");
  $(".auth")?.removeAttribute("hidden");
  const page = document.body.dataset.role;
  if (page) status(`#${page}-status`, message);
}

function appointmentCard(appointment, actions = "") {
  const pre = appointment.preVisitSummary;
  const post = appointment.postVisitSummary;
  return `
    <article class="card">
      <h3>${appointment.doctor?.name || "Doctor"} <span class="badge">${appointment.status}</span></h3>
      <div class="appointment-meta">
        <span>Patient: ${appointment.patient?.name || state.user?.name || "Patient"}</span>
        <span>Time: ${new Date(appointment.startsAt).toLocaleString()}</span>
        <span>Specialisation: ${appointment.doctor?.specialisation || "-"}</span>
        <span>Urgency: ${pre?.urgency || "-"}</span>
      </div>
      <p><strong>Symptoms:</strong> ${pre?.cleanedSymptoms || appointment.symptoms || "-"}</p>
      ${pre ? `<p><strong>Doctor prep:</strong> ${pre.chiefComplaint}<br>${pre.suggestedQuestions.join(" ")}</p>` : ""}
      ${post ? `<p><strong>Patient summary:</strong> ${post.summary}<br><strong>Medication:</strong> ${post.medicationSchedule}</p>` : ""}
      ${appointment.cancelReason ? `<p class="danger">${appointment.cancelReason}</p>` : ""}
      ${actions}
    </article>
  `;
}

async function loadDoctors() {
  const specialisation = $("#specialisation")?.value || "";
  const data = await api(`/api/doctors?specialisation=${encodeURIComponent(specialisation)}`);
  state.doctors = data.doctors;
  const select = $("#doctorId");
  const list = $("#doctor-list");
  if (select) {
    select.innerHTML = data.doctors.length
      ? data.doctors.map(doctor => `<option value="${doctor.id}">${doctor.name} - ${doctor.specialisation}</option>`).join("")
      : `<option value="">No doctors found</option>`;
    renderSelectedDoctorHelp();
  }
  const leaveSelect = $("#leaveDoctorId");
  if (leaveSelect) {
    leaveSelect.innerHTML = data.doctors.map(doctor => `<option value="${doctor.id}">${doctor.name} - ${doctor.specialisation}</option>`).join("");
  }
  if (list) {
    list.innerHTML = data.doctors.map(doctor => `
      <article class="card">
        <h3>${doctor.name}</h3>
        <p>${doctor.specialisation}</p>
        <p class="muted">${doctor.workingHours.start}-${doctor.workingHours.end}, ${doctor.slotDuration} minute slots</p>
        <p class="muted">Leave: ${doctor.leaveDays.join(", ") || "None"}</p>
      </article>
    `).join("");
  }
}

async function loadPatient() {
  if (!ensureRole("patient")) return;
  try {
    setMinimumAppointmentTime();
    await loadDoctors();
    const data = await api("/api/appointments");
    $("#appointment-list").innerHTML = data.appointments.map(appointment => appointmentCard(
      appointment,
      appointment.status === "booked" ? `<button onclick="cancelAppointment('${appointment.id}')">Cancel</button>` : ""
    )).join("") || "<p>No appointments yet.</p>";
  } catch (error) {
    resetSession(error.message);
  }
}

async function bookAppointment() {
  try {
    const validation = validateBookingForm();
    if (validation) {
      status("#booking-status", validation);
      return;
    }
    status("#booking-status", "Confirming appointment...");
    const data = await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        doctorId: $("#doctorId").value,
        startsAt: $("#startsAt").value,
        symptoms: $("#symptoms").value
      })
    });
    status("#booking-status", `Booked. Urgency: ${data.appointment.preVisitSummary.urgency}`, true);
    $("#symptoms").value = "";
    await loadPatient();
  } catch (error) {
    status("#booking-status", error.message);
  }
}

async function cancelAppointment(id) {
  await api(`/api/appointments/${id}/cancel`, { method: "PATCH", body: "{}" });
  await loadPatient();
}

async function loadDoctor() {
  if (!ensureRole("doctor")) return;
  try {
    const data = await api("/api/appointments");
    $("#doctor-appointments").innerHTML = data.appointments.map(appointment => appointmentCard(
      appointment,
      appointment.status === "booked" ? `
        <div class="stack">
          <label>Clinical notes <textarea id="notes-${appointment.id}"></textarea></label>
          <label>Prescription and frequency <textarea id="rx-${appointment.id}" placeholder="Paracetamol 500mg twice daily for 3 days"></textarea></label>
          <button class="primary" onclick="completeVisit('${appointment.id}')">Submit visit notes</button>
        </div>
      ` : ""
    )).join("") || "<p>No appointments assigned.</p>";
  } catch (error) {
    resetSession(error.message);
  }
}

async function completeVisit(id) {
  try {
    await api(`/api/appointments/${id}/visit`, {
      method: "PATCH",
      body: JSON.stringify({
        notes: $(`#notes-${id}`).value,
        prescription: $(`#rx-${id}`).value
      })
    });
    await loadDoctor();
  } catch (error) {
    alert(error.message);
  }
}

async function loadAdmin() {
  if (!ensureRole("admin")) return;
  try {
    await loadDoctors();
    const appointments = await api("/api/appointments");
    $("#admin-appointments").innerHTML = appointments.appointments.map(appointment => appointmentCard(appointment)).join("") || "<p>No appointments yet.</p>";
    const ops = await api("/api/admin/ops");
    updateGoogleCalendarStatus(ops.integrations || {});
    const summary = $("#ops-summary");
    if (summary) {
      const i = ops.integrations || {};
      const emailQueued = (ops.emailOutbox || []).filter(e => e.status === "queued" || e.status === "demo-queued").length;
      const emailSent   = (ops.emailOutbox || []).filter(e => e.status === "sent"   || e.status === "demo-sent").length;
      const calCreated  = (ops.calendarEvents || []).filter(e => e.status === "created" || e.status === "demo-created").length;
      const calQueued   = (ops.calendarEvents || []).filter(e => e.status === "queued").length;
      const reminders   = (ops.medicationReminders || []).length;
      function dot(on) { return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${on ? "#0f766e" : "#d1d5db"};margin-right:6px;vertical-align:middle;"></span>`; }
      summary.innerHTML = `
        <article class="card">
          <h3>Services</h3>
          <p style="margin:4px 0">${dot(i.gemini)} Gemini AI ${i.gemini ? "active" : "not configured"}</p>
          <p style="margin:4px 0">${dot(i.brevo)} Brevo email ${i.brevo ? "active" : "not configured"}</p>
          <p style="margin:4px 0">${dot(i.googleCalendarConnected)} Google Calendar ${i.googleCalendarConnected ? "connected" : i.googleCalendarConfigured ? "configured, not connected" : "not configured"}</p>
        </article>
        <article class="card">
          <h3>Email queue</h3>
          <p style="margin:4px 0"><strong>${emailQueued}</strong> pending &nbsp;·&nbsp; <strong>${emailSent}</strong> sent</p>
        </article>
        <article class="card">
          <h3>Calendar events</h3>
          <p style="margin:4px 0"><strong>${calCreated}</strong> created &nbsp;·&nbsp; <strong>${calQueued}</strong> queued</p>
        </article>
        <article class="card">
          <h3>Medication reminders</h3>
          <p style="margin:4px 0"><strong>${reminders}</strong> scheduled</p>
        </article>
      `;
    }
  } catch (error) {
    resetSession(error.message);
  }
}

async function addDoctor() {
  try {
    await api("/api/admin/doctors", {
      method: "POST",
      body: JSON.stringify({
        name: $("#doctorName").value,
        email: $("#doctorEmail").value,
        password: $("#doctorPassword").value,
        specialisation: $("#doctorSpec").value,
        slotDuration: $("#slotDuration").value,
        workingHours: { start: $("#workStart").value, end: $("#workEnd").value }
      })
    });
    status("#doctor-status", "Doctor profile created.", true);
    await loadAdmin();
  } catch (error) {
    status("#doctor-status", error.message);
  }
}

async function markLeave() {
  try {
    const data = await api(`/api/admin/doctors/${$("#leaveDoctorId").value}/leave`, {
      method: "PATCH",
      body: JSON.stringify({ date: $("#leaveDate").value })
    });
    status("#leave-status", `Leave saved. ${data.affectedAppointments} appointments notified.`, true);
    await loadAdmin();
  } catch (error) {
    status("#leave-status", error.message);
  }
}

async function registerPatient() {
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: $("#registerName").value,
        email: $("#registerEmail").value,
        password: $("#registerPassword").value
      })
    });
    status("#register-status", "Patient registered. You can sign in now.", true);
  } catch (error) {
    status("#register-status", error.message);
  }
}

function updateGoogleCalendarStatus(integrations) {
  const statusText = $("#gcal-status-text");
  const connectBtn = $("#gcal-connect-btn");
  const connectedBadge = $("#gcal-connected-badge");
  if (!statusText) return;

  if (!integrations.googleCalendarConfigured) {
    statusText.textContent = "Google Calendar is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to .env and restart the server.";
    return;
  }

  if (integrations.googleCalendarConnected) {
    statusText.textContent = "Google Calendar is connected. Appointments will automatically appear in the clinic calendar.";
    if (connectedBadge) connectedBadge.removeAttribute("hidden");
    if (connectBtn) connectBtn.setAttribute("hidden", "hidden");
  } else {
    statusText.textContent = "Google Calendar is configured but not yet connected. Click the button below to authorise access.";
    if (connectBtn) connectBtn.removeAttribute("hidden");
    if (connectedBadge) connectedBadge.setAttribute("hidden", "hidden");
  }
}

function connectGoogleCalendar() {
  status("#gcal-status", "Redirecting to Google…");
  window.location.href = "/oauth/google/start";
}

window.login = login;
window.logout = logout;
window.loadPatient = loadPatient;
window.loadDoctor = loadDoctor;
window.loadAdmin = loadAdmin;
window.bookAppointment = bookAppointment;
window.cancelAppointment = cancelAppointment;
window.completeVisit = completeVisit;
window.addDoctor = addDoctor;
window.markLeave = markLeave;
window.registerPatient = registerPatient;
window.connectGoogleCalendar = connectGoogleCalendar;
window.updateGoogleCalendarStatus = updateGoogleCalendarStatus;
window.loadDoctors = loadDoctors;
window.renderSelectedDoctorHelp = renderSelectedDoctorHelp;
