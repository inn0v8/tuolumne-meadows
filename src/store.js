const staged = new Map();
const applications = new Map();
const spinwheelSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, data] of staged) {
    if (new Date(data.expires_at).getTime() < now) {
      staged.delete(id);
    }
  }
  for (const [token, session] of spinwheelSessions) {
    const created = new Date(session.createdAt).getTime();
    if (now - created > 3600000) {
      spinwheelSessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

module.exports = {
  stage(sessionId, data) {
    staged.set(sessionId, data);
  },

  getStaged(sessionId) {
    const data = staged.get(sessionId);
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) {
      staged.delete(sessionId);
      return null;
    }
    return data;
  },

  clearStaged(sessionId) {
    staged.delete(sessionId);
  },

  saveApplication(sessionId, data) {
    applications.set(sessionId, data);
  },

  getApplication(sessionId) {
    return applications.get(sessionId) || null;
  },

  listApplications() {
    return Array.from(applications.entries()).map(([id, app]) => ({
      session_id: id,
      name: app.responses.full_name,
      status: app.result.qualified ? 'prequalified' : 'not_prequalified',
      submitted_at: app.submitted_at,
    }));
  },

  createSpinwheelSession(token, data) {
    spinwheelSessions.set(token, data);
  },

  getSpinwheelSession(token) {
    const session = spinwheelSessions.get(token);
    if (!session) return null;
    const created = new Date(session.createdAt).getTime();
    if (Date.now() - created > 3600000) {
      spinwheelSessions.delete(token);
      return null;
    }
    return session;
  },

  updateSpinwheelSession(token, updates) {
    const session = spinwheelSessions.get(token);
    if (session) {
      Object.assign(session, updates);
    }
  },

  getFullSSN(token) {
    const session = spinwheelSessions.get(token);
    return session?.fullSSN || null;
  },
};
