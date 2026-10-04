// Text matching shared by every search: case and accents ignored, so "rene" finds "René",
// "koln" finds "Köln" and "grusse" finds "Grüße" (ß counts as ss). Cyrillic works the same
// way: "елка" finds "Ёлка".

/** @param {unknown} s */
export const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/ß|ẞ/g, "ss").toLowerCase();

/** Search words of a query, folded. @param {unknown} s */
export const words = (s) => fold(s).split(/\s+/).filter(Boolean);

/** Whether the text contains every (folded) word. */
export const hasAll = (text, ws) => { const h = fold(text); return ws.every((w) => h.includes(w)); };
