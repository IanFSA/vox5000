'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface ProGateProps {
  toolName: string;
  children: React.ReactNode;
}

export default function ProGate({ toolName, children }: ProGateProps) {
  const [isPro, setIsPro] = useState<boolean | null>(null);

  useEffect(() => {
    setIsPro(localStorage.getItem('bizdockit_pro') === 'true');
  }, []);

  // Loading state — avoid flash
  if (isPro === null) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-[#2563EB]" />
      </div>
    );
  }

  if (isPro) return <>{children}</>;

  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center lg:px-8">
      {/* Lock icon */}
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#0A0F1E]">
        <svg className="h-8 w-8 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
        </svg>
      </div>

      <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-amber-700">
        Pro feature
      </span>

      <h1 className="mt-4 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">
        {toolName}
      </h1>

      <p className="mt-4 text-lg leading-8 text-slate-500">
        This tool is included in BizDocKit Pro. Upgrade to access {toolName.toLowerCase()} and all other Pro tools for $6/month.
      </p>

      {/* What's included */}
      <div className="mt-10 rounded-3xl border border-slate-200 bg-slate-50 p-8 text-left">
        <p className="text-sm font-bold uppercase tracking-widest text-slate-400">What you get with Pro</p>
        <ul className="mt-6 space-y-3">
          {[
            'No watermark on any PDF',
            'Proposal generator',
            'Statement of account',
            'Payment reminder composer',
            'Expense tracker with PDF export',
            'Contract generator',
            'Payslip generator',
            'More tools added every month',
          ].map((f) => (
            <li key={f} className="flex items-center gap-3 text-sm text-slate-700">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-xs font-bold text-green-600">✓</span>
              {f}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/pro"
            className="flex-1 rounded-2xl bg-[#2563EB] px-6 py-4 text-center text-sm font-bold text-white shadow-lg shadow-blue-200 transition hover:bg-[#1d4ed8]"
          >
            Upgrade to Pro — $6/month
          </Link>
          <Link
            href="/"
            className="flex-1 rounded-2xl border border-slate-200 bg-white px-6 py-4 text-center text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            Back to free tools
          </Link>
        </div>
      </div>
    </div>
  );
}
