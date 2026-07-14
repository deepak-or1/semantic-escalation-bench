import type { Skin } from "./markup";

/**
 * The single inline stylesheet for every lab page. Selectors are built from
 * the skin so they still match the markup when classDrift renames classes.
 * Dark technical theme; no external assets (the lab runs fully offline).
 */
export function renderStyle(skin: Skin): string {
  const s = (base: string): string => `.${skin.cls(base)}`;
  const css = `
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #0b0e14;
      color: #e2e8f0;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    a { color: #5eead4; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2, h3 { margin: 0 0 0.5rem; font-weight: 650; letter-spacing: -0.01em; }
    ${s("page")} { max-width: 1080px; margin: 0 auto; padding: 0 20px 64px; }
    ${s("site-header")} {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: 20px 0; border-bottom: 1px solid #1e2533;
      margin-bottom: 28px; flex-wrap: wrap;
    }
    ${s("brand")} { font-size: 1.15rem; font-weight: 700; color: #e2e8f0; }
    ${s("brand")} span { color: #5eead4; }
    ${s("nav")} { display: flex; align-items: center; gap: 18px; }
    ${s("nav-link")} { color: #8b93a7; font-size: 0.92rem; font-weight: 550; }
    ${s("nav-link")}:hover { color: #e2e8f0; }
    ${s("signout")} { margin: 0; }
    ${s("main")} { display: block; }
    ${s("panel")} {
      background: #11151f; border: 1px solid #1e2533; border-radius: 12px;
      padding: 22px; margin-bottom: 20px;
    }
    ${s("panel-heading")} {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 12px; margin-bottom: 16px; flex-wrap: wrap;
    }
    ${s("panel-heading")} h1 { font-size: 1.4rem; margin: 0; }
    ${s("note")} {
      font-size: 0.8rem; color: #fbbf24; border: 1px solid #3a2f16;
      background: #1a1608; padding: 3px 9px; border-radius: 999px;
    }
    ${s("subtle")} { color: #8b93a7; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    ${s("table-wrap")} { overflow-x: auto; }
    thead th {
      text-align: right; font-size: 0.72rem; text-transform: uppercase;
      letter-spacing: 0.06em; color: #8b93a7; font-weight: 600;
      padding: 8px 10px; border-bottom: 1px solid #1e2533; white-space: nowrap;
    }
    tbody td {
      text-align: right; padding: 9px 10px; border-bottom: 1px solid #161b26;
      font-size: 0.92rem; white-space: nowrap;
    }
    thead th:nth-child(1), tbody td:nth-child(1) { text-align: center; color: #8b93a7; width: 34px; }
    thead th:nth-child(2), tbody td:nth-child(2) { text-align: left; font-weight: 600; }
    tbody tr:nth-child(even) { background: #0e121b; }
    tbody tr:hover { background: #151b28; }
    ${s("odds-table")} thead th, ${s("odds-table")} tbody td { text-align: left; }
    ${s("form-cell")} { display: inline-flex; gap: 3px; }
    ${s("chip")} {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 5px; font-size: 0.68rem;
      font-weight: 700; color: #0b0e14;
    }
    ${s("chip-w")} { background: #34d399; }
    ${s("chip-d")} { background: #64748b; }
    ${s("chip-l")} { background: #f87171; }
    ${s("team-grid")} {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
    }
    ${s("team-card")} {
      background: #11151f; border: 1px solid #1e2533; border-radius: 12px; padding: 16px;
    }
    ${s("team-card")} h3 { font-size: 1rem; display: flex; align-items: center; gap: 8px; }
    ${s("rank-badge")} {
      background: #1e2533; color: #5eead4; font-size: 0.72rem; font-weight: 700;
      border-radius: 6px; padding: 1px 7px;
    }
    ${s("team-card")} dl {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 6px; margin: 12px 0;
    }
    ${s("team-card")} dt { font-size: 0.66rem; color: #8b93a7; text-transform: uppercase; }
    ${s("team-card")} dd { margin: 0; font-size: 0.95rem; font-weight: 600; }
    ${s("odds-list")} { display: grid; gap: 12px; }
    ${s("odds-card")} {
      background: #11151f; border: 1px solid #1e2533; border-radius: 12px; padding: 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    ${s("odds-card")} ${s("match")} { font-size: 1.05rem; font-weight: 650; }
    ${s("odds-card")} dl {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 4px 0 0;
    }
    ${s("odds-card")} dt { font-size: 0.66rem; color: #8b93a7; text-transform: uppercase; }
    ${s("odds-card")} dd { margin: 0; font-weight: 650; font-variant-numeric: tabular-nums; }
    ${s("tabs")} { display: flex; gap: 8px; margin-bottom: 16px; }
    ${s("tab-button")} {
      background: #0e121b; border: 1px solid #1e2533; color: #8b93a7;
      padding: 7px 14px; border-radius: 8px; font-size: 0.9rem; font-weight: 550; cursor: pointer;
    }
    ${s("tab-active")} { background: #11251f; border-color: #2f5f52; color: #5eead4; }
    ${s("top3")} { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
    ${s("top3")} li {
      display: flex; justify-content: space-between; padding: 8px 12px;
      background: #0e121b; border: 1px solid #1e2533; border-radius: 8px;
    }
    ${s("pager")} {
      display: flex; align-items: center; gap: 14px; margin-top: 16px; justify-content: flex-end;
    }
    ${s("page-indicator")} { color: #8b93a7; font-size: 0.88rem; }
    ${s("btn")} {
      background: #1a2130; border: 1px solid #2a3446; color: #e2e8f0;
      padding: 8px 16px; border-radius: 8px; font-size: 0.9rem; font-weight: 550;
      cursor: pointer; font-family: inherit;
    }
    ${s("btn")}:hover { border-color: #3a4761; }
    ${s("btn-primary")} { background: #5eead4; border-color: #5eead4; color: #052e26; font-weight: 650; }
    ${s("btn-primary")}:hover { background: #7ff0dd; }
    ${s("skeleton")} { display: grid; gap: 10px; }
    ${s("shimmer-row")} {
      height: 34px; border-radius: 8px;
      background: linear-gradient(90deg, #10141d 25%, #1a2130 37%, #10141d 63%);
      background-size: 400% 100%; animation: ${skin.cls("shimmer")} 1.4s ease infinite;
    }
    @keyframes ${skin.cls("shimmer")} {
      0% { background-position: 100% 50%; } 100% { background-position: 0 50%; }
    }
    ${s("login-card")} { max-width: 380px; margin: 40px auto; }
    ${s("field")} { display: block; margin-bottom: 14px; }
    ${s("field")} span { display: block; font-size: 0.8rem; color: #8b93a7; margin-bottom: 5px; }
    ${s("field")} input {
      width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3446;
      background: #0b0e14; color: #e2e8f0; font-size: 0.95rem; font-family: inherit;
    }
    ${s("field")} input:focus { outline: none; border-color: #5eead4; }
    ${s("error")} {
      background: #2a1416; border: 1px solid #5a2528; color: #fca5a5;
      padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; font-size: 0.9rem;
    }
    ${s("consent-card")} { max-width: 520px; margin: 48px auto; text-align: center; }
    ${s("consent-card")} p { color: #8b93a7; margin: 8px 0 22px; }
    ${s("consent-actions")} { display: flex; flex-direction: column; align-items: center; gap: 14px; }
    ${s("manage-settings")} { color: #8b93a7; font-size: 0.88rem; }
    ${s("modal-backdrop")} {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(3, 5, 9, 0.72); backdrop-filter: blur(2px);
      display: flex; align-items: center; justify-content: center; padding: 20px;
    }
    ${s("newsletter-modal")} {
      background: #11151f; border: 1px solid #2a3446; border-radius: 14px;
      padding: 26px; max-width: 400px; width: 100%; text-align: center;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
    }
    ${s("newsletter-modal")} p { color: #8b93a7; margin: 8px 0 20px; }
    ${s("modal-actions")} { display: flex; gap: 10px; justify-content: center; }
    ${s("footer")} {
      margin-top: 36px; padding-top: 18px; border-top: 1px solid #1e2533;
      color: #8b93a7; font-size: 0.82rem;
    }
  `;
  return `<style>${css}</style>`;
}
