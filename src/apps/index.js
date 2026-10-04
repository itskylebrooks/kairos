// Every tool from every app. The server filters them by config.
import { tools as calendar } from "./calendar.js";
import { tools as contacts } from "./contacts.js";
import { tools as kairos } from "./kairos.js";
import { tools as mail } from "./mail.js";
import { tools as music } from "./music.js";
import { tools as notes } from "./notes.js";
import { tools as reminders } from "./reminders.js";

/** @type {readonly import("../lib/tools.js").Tool[]} */
export const ALL_TOOLS = Object.freeze([...calendar, ...reminders, ...contacts, ...notes, ...mail, ...music, ...kairos]);
