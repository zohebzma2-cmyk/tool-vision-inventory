// User-customized label templates, persisted in the browser (localStorage).
// Users start from a built-in, tweak the text/fields/style, and save their own named templates.
// getAllTemplates() merges built-ins + custom so they appear everywhere a template is chosen.

import { BUILTIN_TEMPLATES, type LabelTemplate } from "./labelTemplates";

const KEY = "tvi.customTemplates.v1";

export function getCustomTemplates(): LabelTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LabelTemplate[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomTemplate(t: LabelTemplate): void {
  const all = getCustomTemplates();
  const idx = all.findIndex((x) => x.id === t.id);
  if (idx >= 0) all[idx] = t;
  else all.push(t);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deleteCustomTemplate(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(getCustomTemplates().filter((t) => t.id !== id)));
}

/** Built-ins first, then the user's saved custom templates. */
export function getAllTemplates(): LabelTemplate[] {
  return [...BUILTIN_TEMPLATES, ...getCustomTemplates()];
}

/** Resolve a template id across custom + built-in, falling back to the first built-in. */
export function resolveTemplate(id: string | undefined | null): LabelTemplate {
  return getAllTemplates().find((t) => t.id === id) ?? BUILTIN_TEMPLATES[0];
}

export function isCustomId(id: string): boolean {
  return getCustomTemplates().some((t) => t.id === id);
}
