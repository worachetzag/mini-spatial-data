import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { en, th } from "./strings.js";

const STORAGE_KEY = "mini-spatial-lang";

const dict = { en, th };

const I18nContext = createContext(null);

function interpolate(template, params) {
  if (!params || typeof template !== "string") return template;
  let s = template;
  for (const [k, v] of Object.entries(params)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s === "th" || s === "en") return s;
    } catch {
      /* ignore */
    }
    return "th";
  });

  const setLang = useCallback((next) => {
    if (next !== "th" && next !== "en") return;
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key, params) => {
      const table = dict[lang] || dict.en;
      const fallback = dict.en;
      let s = table[key] ?? fallback[key] ?? key;
      return interpolate(s, params);
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
