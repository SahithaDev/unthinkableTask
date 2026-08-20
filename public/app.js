const state = {
  token: localStorage.getItem("token") || "",
  user: JSON.parse(localStorage.getItem("user") || "null")
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
  $(".user-name").textContent = state.user.name;
  return true;
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
      <p><strong>Symptoms:</strong> ${appointment.symptoms || "-"}</p>
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
  const select = $("#doctorId");
  const list = $("#doctor-list");
  if (select) {
    select.innerHTML = data.doctors.map(doctor => `<option value="${doctor.id}">${doctor.name} - ${doctor.specialisation}</option>`).join("");
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
  await loadDoctors();
  const data = await api("/api/appointments");
  $("#appointment-list").innerHTML = data.appointments.map(appointment => appointmentCard(
    appointment,
    appointment.status === "booked" ? `<button onclick="cancelAppointment('${appointment.id}')">Cancel</button>` : ""
  )).join("") || "<p>No appointments yet.</p>";
}

async function bookAppointment() {
  try {
    const data = await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        doctorId: $("#doctorId").value,
        startsAt: $("#startsAt").value,
        symptoms: $("#symptoms").value
      })
    });
    status("#booking-status", `Booked. Urgency: ${data.appointment.preVisitSummary.urgency}`, true);
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
  await loadDoctors();
  const appointments = await api("/api/appointments");
  $("#admin-appointments").innerHTML = appointments.appointments.map(appointment => appointmentCard(appointment)).join("") || "<p>No appointments yet.</p>";
  const ops = await api("/api/admin/ops");
  $("#ops").textContent = JSON.stringify(ops, null, 2);
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
window.loadDoctors = loadDoctors;
