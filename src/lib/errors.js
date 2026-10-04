// Errors whose message is meant for the model and the user, as opposed to bugs.

export class UserError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

// osascript: -1743 = not authorized to send Apple Events, -10004 = privilege violation.
const PERMISSION_RE = /not allowed|not authori[sz]ed|-1743|-10004/i;

/** @param {unknown} e */
export const isPermissionError = (e) => PERMISSION_RE.test(String(e instanceof Error ? e.message : e));

/**
 * Says exactly what to allow, and where.
 * @param {string} app  e.g. "Contacts"
 * @param {string} [pane]  Privacy & Security pane, e.g. "Automation" or "Calendars"
 */
export function permissionError(app, pane = "Automation") {
  return new UserError(
    `macOS hasn't allowed access to ${app} yet. Allow it in the prompt, or in System Settings > Privacy & Security > ${pane}, then try again.`,
  );
}
