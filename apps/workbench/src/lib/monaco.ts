import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/contrib/documentSymbols/browser/outlineModel';
import 'monaco-editor/language/json/monaco.contribution';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    return label === 'json' ? new jsonWorker() : new editorWorker();
  },
};

// Keep the localhost workbench self-contained. The React wrapper otherwise
// downloads Monaco from a CDN at runtime.
loader.config({ monaco });
