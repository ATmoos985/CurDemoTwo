import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/studio.css';
import './styles/theme-magpie.css';
import './styles/theme-magpie-results.css';
import './styles/theme-magpie-inventory.css';
import './styles/theme-magpie-showcase.css';
import './styles/tokens-dark.css';
import { applyThemeToDocument, loadStudioSettings } from './store/studioSettings';

applyThemeToDocument(loadStudioSettings().theme);

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
