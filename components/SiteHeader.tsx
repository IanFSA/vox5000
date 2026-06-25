'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

const documentTools = [
  { label: "Invoice Generator", href: "/free-invoice-generator" },
  { label: "Quote Generator", href: "/free-quote-generator" },
  { label: "Estimate Generator", href: "/free-estimate-generator" },
  { label: "Receipt Generator", href: "/free-receipt-generator" },
  { label: "Pro Forma Invoice", href: "/free-pro-forma-invoice-generator" },
  { label: "Credit Note", href: "/free-credit-note-generator" },
  { label: "Purchase Order", href: "/free-purchase-order-generator" },
  { label: "Delivery Note", href: "/free-delivery-note-generator" },
  { label: "Packing Slip", href: "/free-packing-slip-generator" },
  { label: "Commercial Invoice", href: "/free-commercial-invoice-generator" },
];

export default function SiteHeader() {
  const [isOpen, setIsOpen] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);

  function closeMenus() {
    setIsOpen(false);
    setIsToolsOpen(false);
  }

  return (
    <header className="sticky top-0 z-50 border-b border-slate-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">

        {/* Logo */}
        <Link
          href="/"
          className="flex h-14 w-[220px] shrink-0 items-center overflow-visible"
          aria-label="BizDocKit home"
          onClick={closeMenus}
        >
          <Image
            src="/bizdockit-logo-text.png"
            alt="BizDocKit"
            width={420}
            height={120}
            priority
            className="h-14 w-auto origin-left scale-[1.6] sm:h-28 sm:scale-[1.65]"
          />
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-8 md:flex">
          <div className="relative">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 transition hover:text-slate-950"
              onClick={() => setIsToolsOpen((v) => !v)}
              aria-expanded={isToolsOpen}
              aria-haspopup="true"
            >
              Document Tools
              <svg className={`h-3.5 w-3.5 transition-transform ${isToolsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isToolsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={closeMenus} />
                <div className="absolute left-1/2 top-full z-20 mt-3 w-80 -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/80 max-h-[80vh] overflow-y-auto">
                  <div className="grid gap-0.5">
                    {documentTools.map((tool) => (
                      <Link
                        key={tool.href}
                        href={tool.href}
                        className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 hover:text-slate-950"
                        onClick={closeMenus}
                      >
                        {tool.label}
                      </Link>
                    ))}
                  </div>
                  <div className="mt-2 border-t border-slate-100 pt-2">
                    <p className="px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-amber-600">Pro tools ✦</p>
                    {[
                      { label: 'Proposal Generator', href: '/pro-proposal-generator' },
                      { label: 'Statement of Account', href: '/pro-statement-of-account' },
                      { label: 'Payment Reminder', href: '/pro-payment-reminder' },
                      { label: 'Expense Tracker', href: '/pro-expense-tracker' },
                      { label: 'Contract Generator', href: '/pro-contract-generator' },
                      { label: 'Payslip Generator', href: '/pro-payslip-generator' },
                    ].map(tool => (
                      <Link key={tool.href} href={tool.href} className="block rounded-xl px-4 py-2.5 text-sm font-medium text-amber-700 transition hover:bg-amber-50" onClick={closeMenus}>
                        {tool.label}
                      </Link>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <Link
            href="/pro"
            className="text-sm font-semibold text-amber-600 transition hover:text-amber-700"
            onClick={closeMenus}
          >
            Pro ✦
          </Link>
        </nav>

        {/* Desktop CTA */}
        <div className="hidden items-center gap-3 md:flex">
          <Link
            href="/pro"
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            onClick={closeMenus}
          >
            Go Pro
          </Link>
          <Link
            href="/free-invoice-generator"
            className="rounded-xl bg-[#0A0F1E] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#1a2030]"
            onClick={closeMenus}
          >
            Create invoice
          </Link>
        </div>

        {/* Mobile menu button */}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 md:hidden"
          onClick={() => { setIsOpen((v) => !v); setIsToolsOpen(false); }}
          aria-expanded={isOpen}
          aria-label="Toggle menu"
        >
          {isOpen ? '✕ Close' : '☰ Menu'}
        </button>
      </div>

      {/* Mobile menu */}
      {isOpen && (
        <div className="border-t border-slate-100 bg-white px-4 pb-6 pt-4 md:hidden">
          <nav className="mx-auto flex max-w-7xl flex-col gap-1">
            <button
              type="button"
              className="flex items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setIsToolsOpen((v) => !v)}
            >
              Document Tools
              <svg className={`h-4 w-4 transition-transform ${isToolsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isToolsOpen && (
              <div className="mb-2 rounded-2xl bg-slate-50 p-2">
                {documentTools.map((tool) => (
                  <Link
                    key={tool.href}
                    href={tool.href}
                    className="block rounded-xl px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-white"
                    onClick={closeMenus}
                  >
                    {tool.label}
                  </Link>
                ))}
              </div>
            )}

            <Link
              href="/pro"
              className="rounded-xl px-3 py-3 text-sm font-bold text-amber-600 hover:bg-amber-50"
              onClick={closeMenus}
            >
              Pro ✦ — Remove watermark
            </Link>

            <div className="mt-3 grid gap-2">
              <Link
                href="/free-invoice-generator"
                className="rounded-xl bg-[#0A0F1E] px-4 py-3 text-center text-sm font-bold text-white"
                onClick={closeMenus}
              >
                Create invoice
              </Link>
              <Link
                href="/pro"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-semibold text-slate-700"
                onClick={closeMenus}
              >
                See Pro pricing
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
