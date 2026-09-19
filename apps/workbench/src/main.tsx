import React from 'react';
import ReactDOM from 'react-dom/client';
import '@radix-ui/themes/styles.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { initializeDesktop } from './lib/desktop';

const root = ReactDOM.createRoot(document.getElementById('root')!);

void initializeDesktop()
  .then(() => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((cause) => {
    const message = cause instanceof Error ? cause.message : 'The local desktop engine could not start.';
    root.render(
      <main className="desktop-bootstrap-error" role="alert">
        <h1>Aone Execution could not start</h1>
        <p>{message}</p>
      </main>,
    );
  });
