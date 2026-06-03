import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mark — JBC Finance Manager",
  description:
    "Orchestrator across 7 finance specialists. Synthesises, prioritises, escalates — never acts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="appbar">
          <Link href="/" className="appbar-logo">
            <span className="appbar-dot" />
            <span>Mark</span>
            <span className="appbar-tag">JBC Finance Manager</span>
          </Link>
          <nav className="appbar-nav">
            <Link href="/" className="appbar-link">Today</Link>
            <Link href="/briefs" className="appbar-link">Briefs</Link>
            <Link href="/specialists" className="appbar-link">Specialists</Link>
            <Link href="/imports" className="appbar-link">Imports</Link>
            <Link href="/hermes-activity" className="appbar-link">Hermes</Link>
            <Link href="/goals" className="appbar-link">Goals</Link>
            <Link href="/reports/profit" className="appbar-link">Reports</Link>
            <Link href="/cash-forecast" className="appbar-link">Cash forecast</Link>
            <Link href="/payroll-journal" className="appbar-link">Payroll journal</Link>
            <Link href="/qa" className="appbar-link">Ask Mark</Link>
            <Link href="/restricted" className="appbar-link">Restricted</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
