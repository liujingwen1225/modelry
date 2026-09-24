import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles/tokens.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The Admin root element is missing.');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
