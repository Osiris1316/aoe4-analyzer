// Start: turn any old #view= address into today's, then draw the pages.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { legacyPath } from './app/paths';
import { createAppRouter } from './app/router';
import './styles/tokens.css';
import './styles/base.css';

const legacy = legacyPath(location.hash);
if (legacy) history.replaceState(null, '', legacy);

const router = createAppRouter();

window.addEventListener('hashchange', () => {
  const to = legacyPath(location.hash);
  if (to) void router.navigate(to, { replace: true });
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>,
);
