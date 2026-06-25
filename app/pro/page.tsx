import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "BizDocKit Pro — Clean PDFs, No Watermark",
  description:
    "Upgrade to BizDocKit Pro and remove the watermark from all your PDFs. Premium templates, business profile and more.",
};

const proFeatures = [
  { label: "No watermark on PDFs", included: true },
  { label: "All 10 document types", included: true },
  { label: "Proposal generator", included: true },
  { label: "Statement of account", included: true },
  { label: "Payment reminder composer", included: true },
  { label: "Expense tracker + PDF export", included: true },
  { label: "Contract generator", included: true },
  { label: "Payslip generator", included: true },
  { label: "More tools added every month", included: true },
];

const freeFeatures = [
  { label: "No watermark on PDFs", included: false },
  { label: "All 10 document types", included: true },
  { label: "Premium PDF templates", included: false },
  { label: "Save your business profile", included: false },
  { label: "Priority support", included: false },
];

export default function ProPage() {
  return (
    <main className="min-h-screen bg-[#f6f8fb] text-[#101828]">
      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pb-16 pt-20 text-center lg:px-8">
        <span className="inline-block rounded-full bg-blue-100 px-4 py-1.5 text-sm font-semibold text-blue-700">
          BizDocKit Pro
        </span>
        <h1 className="mt-6 text-5xl font-semibold tracking-[-0.04em] text-[#101828] sm:text-6xl">
          Clean PDFs.<br />No watermark.
        </h1>
        <p className="mt-6 text-xl leading-8 text-[#667085]">
          One simple upgrade. Every document you create looks completely professional — your brand, nothing else.
        </p>
      </section>

      {/* Pricing cards */}
      <section className="mx-auto max-w-4xl px-6 pb-20 lg:px-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Free */}
          <div className="rounded-3xl border border-[#e4e7ec] bg-white p-8">
            <p className="text-sm font-semibold uppercase tracking-widest text-[#667085]">Free</p>
            <div className="mt-4 flex items-end gap-1">
              <span className="text-4xl font-bold text-[#101828]">$0</span>
              <span className="mb-1 text-[#667085]">/ forever</span>
            </div>
            <p className="mt-3 text-sm text-[#667085]">Everything you need to get started. Watermark included.</p>

            <ul className="mt-8 space-y-3">
              {freeFeatures.map((f) => (
                <li key={f.label} className="flex items-center gap-3 text-sm">
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${f.included ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-400"}`}>
                    {f.included ? "✓" : "✗"}
                  </span>
                  <span className={f.included ? "text-[#344054]" : "text-[#98a2b3]"}>{f.label}</span>
                </li>
              ))}
            </ul>

            <Link
              href="/free-invoice-generator"
              className="mt-8 block rounded-2xl border border-[#d0d5dd] bg-white px-6 py-3.5 text-center text-sm font-semibold text-[#344054] transition hover:border-[#98a2b3]"
            >
              Continue with free
            </Link>
          </div>

          {/* Pro */}
          <div className="rounded-3xl border-2 border-[#2563eb] bg-[#101828] p-8 text-white">
            <p className="text-sm font-semibold uppercase tracking-widest text-blue-400">Pro</p>
            <div className="mt-4 flex items-end gap-1">
              <span className="text-4xl font-bold">$5</span>
              <span className="mb-1 text-white/60">/ month</span>
            </div>
            <p className="mt-3 text-sm text-white/60">Every document. Fully professional. Your brand only.</p>

            <ul className="mt-8 space-y-3">
              {proFeatures.map((f) => (
                <li key={f.label} className="flex items-center gap-3 text-sm">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-xs font-bold text-blue-400">
                    ✓
                  </span>
                  <span className="text-white/90">{f.label}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 rounded-2xl bg-white/10 px-6 py-4 text-center">
              <p className="text-sm font-semibold text-white">Payments coming soon</p>
              <p className="mt-1 text-xs text-white/50">Stripe integration in progress. Check back shortly.</p>
            </div>
          </div>
        </div>

        <p className="mt-8 text-center text-sm text-[#98a2b3]">
          No subscription required for free tier. Pro billed monthly. Cancel any time.
        </p>
      </section>

      {/* Back to tools */}
      <section className="border-t border-[#e4e7ec] bg-white py-12">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 px-6 text-center lg:px-8">
          <p className="text-[#667085]">Ready to create your document?</p>
          <Link
            href="/free-invoice-generator"
            className="inline-flex items-center justify-center rounded-2xl bg-[#2563eb] px-7 py-4 text-base font-semibold text-white shadow-lg shadow-blue-200 transition hover:bg-[#1d4ed8]"
          >
            Create an invoice
          </Link>
        </div>
      </section>
    </main>
  );
}
