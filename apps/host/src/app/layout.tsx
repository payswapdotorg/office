// Office browser host — the root layout (OFF-DEPLOY): the semantic shell
// every page renders inside. A server component (no client JavaScript of its
// own); the navigation is plain anchor markup — keyboard-focusable by
// construction.
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Office browser host',
  description:
    'The Office project workspace, control tower, and evidence ledger — the browser host over @office/web.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <h1>Office browser host</h1>
          <nav aria-label="Primary">
            <ul>
              <li>
                <a href="/">Workspace</a>
              </li>
              <li>
                <a href="/control-tower">Control tower</a>
              </li>
              <li>
                <a href="/evidence">Evidence</a>
              </li>
              <li>
                <a href="/api/health">Health</a>
              </li>
            </ul>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
