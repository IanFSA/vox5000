'use client';

import { useState } from 'react';
import ProGate from '@/components/ProGate';

type Tone = 'friendly' | 'firm' | 'final';

export default function PaymentReminder() {
  const [clientName, setClientName] = useState('');
  const [yourName, setYourName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [daysOverdue, setDaysOverdue] = useState('');
  const [tone, setTone] = useState<Tone>('friendly');
  const [copied, setCopied] = useState(false);

  function generateEmail(): { subject: string; body: string } {
    const cn = clientName || '[Client Name]';
    const yn = yourName || '[Your Name]';
    const inv = invoiceNumber || '[Invoice Number]';
    const amt = amount ? `$${amount}` : '[Amount]';
    const due = dueDate || '[Due Date]';
    const days = daysOverdue ? `${daysOverdue} days` : '[X days]';

    if (tone === 'friendly') {
      return {
        subject: `Friendly reminder: Invoice ${inv} payment`,
        body: `Hi ${cn},

I hope you're doing well. I just wanted to send a quick reminder that Invoice ${inv} for ${amt} was due on ${due}.

If you've already sent payment, please ignore this message — and thank you! If not, I'd appreciate it if you could arrange payment at your earliest convenience.

Please don't hesitate to reach out if you have any questions or if there's anything I can help with.

Warm regards,
${yn}`,
      };
    }

    if (tone === 'firm') {
      return {
        subject: `Payment overdue: Invoice ${inv} — ${days} past due`,
        body: `Hi ${cn},

I'm following up on Invoice ${inv} for ${amt}, which was due on ${due} and is now ${days} overdue.

I'd appreciate your prompt attention to this matter. Please arrange payment as soon as possible or contact me to discuss if there is an issue.

If you have already made payment, please send me confirmation of the transfer so I can update my records.

Regards,
${yn}`,
      };
    }

    return {
      subject: `Final notice: Invoice ${inv} — immediate payment required`,
      body: `Hi ${cn},

Despite previous reminders, Invoice ${inv} for ${amt} (due ${due}) remains unpaid after ${days}.

This is a final notice. Please arrange full payment within 5 business days to avoid further action.

If payment is not received by this deadline, I will have no option but to pursue this matter further, which may include engaging a collections agency or taking legal action to recover the outstanding amount.

If there is a genuine reason for the delay, please contact me immediately so we can discuss a resolution.

Regards,
${yn}`,
    };
  }

  const email = generateEmail();

  function copyEmail() {
    navigator.clipboard.writeText(`Subject: ${email.subject}\n\n${email.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const tones: { value: Tone; label: string; desc: string; color: string }[] = [
    { value: 'friendly', label: 'Friendly', desc: 'First reminder, warm tone', color: 'bg-green-100 text-green-700 border-green-200' },
    { value: 'firm', label: 'Firm', desc: 'Second reminder, direct', color: 'bg-amber-100 text-amber-700 border-amber-200' },
    { value: 'final', label: 'Final notice', desc: 'Last warning before action', color: 'bg-red-100 text-red-700 border-red-200' },
  ];

  return (
    <ProGate toolName="Payment Reminder Composer">
      <section className="mx-auto max-w-5xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">Pro tool</span>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">Payment Reminder Composer</h1>
          <p className="mt-2 text-slate-500">Generate a professional payment chaser email in seconds. Copy and send.</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Inputs */}
          <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Details</p>

            {[
              { label: 'Your name', val: yourName, set: setYourName, ph: 'Jane Smith' },
              { label: 'Client name', val: clientName, set: setClientName, ph: 'John Client' },
              { label: 'Invoice number', val: invoiceNumber, set: setInvoiceNumber, ph: 'INV-042' },
              { label: 'Amount owed', val: amount, set: setAmount, ph: '1500.00' },
              { label: 'Original due date', val: dueDate, set: setDueDate, ph: '2025-01-01', type: 'date' },
              { label: 'Days overdue', val: daysOverdue, set: setDaysOverdue, ph: '14' },
            ].map(({ label, val, set, ph, type }) => (
              <div key={label}>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
                <input
                  type={type || 'text'}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  value={val}
                  onChange={e => set(e.target.value)}
                  placeholder={ph}
                />
              </div>
            ))}

            <div>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">Tone</label>
              <div className="grid gap-2">
                {tones.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTone(t.value)}
                    className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left transition ${tone === t.value ? t.color + ' border-current' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                  >
                    <span className="text-sm font-bold">{t.label}</span>
                    <span className="text-xs">{t.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Email preview */}
          <div className="flex flex-col rounded-3xl border border-slate-200 bg-slate-50 p-6">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Generated email</p>
              <button
                type="button"
                onClick={copyEmail}
                className="rounded-xl bg-[#0A0F1E] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#1a2030]"
              >
                {copied ? '✓ Copied!' : 'Copy email'}
              </button>
            </div>

            <div className="flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 bg-slate-50 px-5 py-3">
                <p className="text-xs text-slate-500">Subject</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">{email.subject}</p>
              </div>
              <div className="p-5">
                <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{email.body}</p>
              </div>
            </div>

            <p className="mt-4 text-xs text-slate-400">Copy this email and paste it into your email client. Adjust as needed before sending.</p>
          </div>
        </div>
      </section>
    </ProGate>
  );
}
