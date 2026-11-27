import React from 'react';
import type { ThumbKind } from './showcaseCaseMeta';

/** Minimalist SVG geometry thumbnail that visually explains each case's cutting pattern at a glance. */
export const CaseThumbSvg: React.FC<{ kind: ThumbKind }> = ({ kind }) => {
  switch (kind) {
    case 'crosscut':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="4" y="4" width="44" height="9" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="4" y="15" width="44" height="9" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
          <line x1="2" y1="14" x2="50" y2="14" stroke="#4f46e5" strokeDasharray="2 1.5" />
          <line x1="2" y1="25" x2="50" y2="25" stroke="#4f46e5" strokeDasharray="2 1.5" />
        </svg>
      );
    case 'defect':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="4" y="4" width="44" height="7" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <rect x="6" y="14" width="7" height="7" rx="1" fill="#fee2e2" stroke="#e11d48" />
          <rect x="16" y="13" width="32" height="19" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="4" y="23" width="10" height="9" rx="1.5" fill="#ede9fe" stroke="#8b5cf6" />
        </svg>
      );
    case 'remnant':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="4" y="4" width="26" height="19" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
          <rect x="32" y="4" width="16" height="9" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="32" y="15" width="16" height="8" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="4" y="25" width="44" height="7" rx="1.5" fill="#fef3c7" stroke="#d97706" />
        </svg>
      );
    case 'contour':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <polygon points="5,5 25,5 25,14 14,14 14,30 5,30" fill="#e0e7ff" stroke="#6366f1" />
          <polygon points="16,16 34,16 30,31 16,31" fill="#d1fae5" stroke="#10b981" />
          <polygon points="27,5 47,5 47,29 36,29 36,14 27,14" fill="#fef3c7" stroke="#d97706" />
        </svg>
      );
    case 'marker':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <polygon points="5,5 21,5 23,16 5,16" fill="#e0e7ff" stroke="#6366f1" />
          <polygon points="5,19 23,19 21,31 5,31" fill="#dbeafe" stroke="#3b82f6" />
          <polygon points="25,5 39,7 39,17 25,17" fill="#d1fae5" stroke="#10b981" />
          <rect x="25" y="20" width="13" height="11" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <line x1="41" y1="3" x2="41" y2="33" stroke="#10b981" strokeWidth="1.5" strokeDasharray="2 1.5" />
        </svg>
      );
    case 'slitting':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="4" width="13" height="28" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="19" y="4" width="13" height="28" fill="#dbeafe" stroke="#3b82f6" />
          <rect x="33" y="4" width="9" height="28" fill="#d1fae5" stroke="#10b981" />
          <rect x="43" y="4" width="5" height="28" fill="#fef3c7" stroke="#d97706" />
        </svg>
      );
    case 'grain-lock':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="5" width="20" height="12" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <rect x="27" y="5" width="20" height="12" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <line x1="8" y1="11" x2="22" y2="11" stroke="#b45309" strokeWidth="1.2" />
          <line x1="30" y1="11" x2="44" y2="11" stroke="#b45309" strokeWidth="1.2" />
          <rect x="5" y="19" width="26" height="11" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
        </svg>
      );
    case 'grain-free':
    case 'rotate-ok':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="5" width="22" height="26" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="29" y="5" width="18" height="12" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="29" y="19" width="18" height="12" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
        </svg>
      );
    case 'block':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="34" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="6" y="8" width="42" height="18" rx="2" fill="rgba(225,29,72,0.12)" stroke="#e11d48" strokeDasharray="2.5 1.5" />
        </svg>
      );
    case 'gap':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="6" y="6" width="17" height="24" rx="2" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="29" y="6" width="17" height="24" rx="2" fill="#d1fae5" stroke="#10b981" />
          <line x1="26" y1="6" x2="26" y2="30" stroke="#d97706" strokeDasharray="2 1.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="5" width="24" height="15" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="31" y="5" width="16" height="15" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="5" y="22" width="42" height="9" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
        </svg>
      );
  }
};
