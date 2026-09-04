import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";

// Inter carries the ss03 stylistic set globals.css switches on; Geist Mono stays for
// code, run ids and any other place a column has to line up.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "qa-pilot",
  description: "Live view of qa-pilot autonomous test-orchestration runs",
};

/**
 * Applies the stored theme before first paint. Without this the page renders dark, then
 * flips to light on hydration, which is the one thing a theme toggle must never do.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("qa-pilot-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full bg-app text-body">{children}</body>
    </html>
  );
}
