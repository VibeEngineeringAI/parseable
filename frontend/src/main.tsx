import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppProvider } from './app/AppProvider';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/global.css';
import { basePath } from './lib/config';
const router = createBrowserRouter([{ path: '*', element: <App /> }], {
  basename: basePath || undefined,
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <RouterProvider router={router} />
    </AppProvider>
  </React.StrictMode>,
);
