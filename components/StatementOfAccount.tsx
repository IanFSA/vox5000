'use client';

import { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import ProGate from '@/components/ProGate';

interface InvoiceRow {
  id: string;
  date: string;
  description: string;
  amount: string;
  paid: string;
}

interface StatementData {
  statementDate: string;
  fromName: string;
  fromEmail: string;
  fromAddress: string;
  toName: string;
  toCompany: string;
  toEmail: string;
  currency: string;
  accentColor: string;
  rows: InvoiceRow[];
  notes: string;
}

const empty: StatementData = {
  statementDate: new Date().toISOString().split('T')[0],
  fromName: '',
  fromEmail: '',
  fromAddress: '',
  toName: '',
  toCompany: '',
  toEmail: '',
  currency: '$',
  accentColor: '#2563EB',
  notes: 'Please contact us if you have any queries regarding this statement.',
  rows: [{ id: '1', date: '', description: '', amount: '', paid: '' }],
};

const STORAGE_KEY = 'bizdockit_statement_v1';
const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';

function field(label: string, el: React.ReactNode) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {el}
    </div>
  );
}

export default function StatementOfAccount() {
  const [data, setData] = useState<StatementData>(empty);

  useEffect(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) setData(JSON.parse(s)); } catch { /* ignore */ }
  }, []);

  function update(patch: Partial<StatementData>) {
    setData(prev => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function addRow() {
    update({ rows: [...data.rows, { id: Date.now().toString(), date: '', description: '', amount: '', paid: '' }] });
  }

  function updateRow(id: string, field: keyof InvoiceRow, val: string) {
    update({ rows: data.rows.map(r => r.id === id ? { ...r, [field]: val } : r) });
  }

  function removeRow(id: string) {
    if (data.rows.length === 1) return;
    update({ rows: data.rows.filter(r => r.id !== id) });
  }

  const totalAmount = data.rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const totalPaid = data.rows.reduce((s, r) => s + (parseFloat(r.paid) || 0), 0);
  const balance = totalAmount - totalPaid;
  const fmt = (n: number) => `${data.currency}${n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function hexToRgb(hex: string): [number, number, number] {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  function generatePdf() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 48;
    const [ar, ag, ab] = hexToRgb(data.accentColor);

    doc.setFillColor(ar, ag, ab);
    doc.rect(0, 0, pw, 90, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(255, 255, 255);
    doc.text('STATEMENT OF ACCOUNT', m, 40);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Date: ${data.statementDate}`, pw - m, 60, { align: 'right' });

    let y = 120;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(ar, ag, ab);
    doc.text('FROM', m, y);
    doc.text('TO', pw / 2 + 10, y);
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(10);
    [data.fromName, data.fromEmail, data.fromAddress].filter(Boolean).forEach(l => { doc.text(l, m, y); y += 13; });
    let y2 = 132;
    [data.toName, data.toCompany, data.toEmail].filter(Boolean).forEach(l => { doc.text(l, pw / 2 + 10, y2); y2 += 13; });
    y = Math.max(y, y2) + 16;

    // Table header
    doc.setFillColor(ar, ag, ab);
    doc.rect(m, y, pw - m * 2, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    const cols = [m + 4, m + 80, pw - 180, pw - 100, pw - m - 4];
    doc.text('DATE', cols[0], y + 14);
    doc.text('DESCRIPTION', cols[1], y + 14);
    doc.text('AMOUNT', cols[2], y + 14, { align: 'right' });
    doc.text('PAID', cols[3], y + 14, { align: 'right' });
    doc.text('BALANCE', cols[4], y + 14, { align: 'right' });
    y += 22;

    data.rows.forEach((row, i) => {
      if (y > ph - 100) { doc.addPage(); y = 48; }
      if (i % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(m, y, pw - m * 2, 20, 'F'); }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(50, 50, 50);
      const amt = parseFloat(row.amount) || 0;
      const paid = parseFloat(row.paid) || 0;
      const bal = amt - paid;
      doc.text(row.date || '—', cols[0], y + 13);
      doc.text(row.description || '—', cols[1], y + 13);
      doc.text(fmt(amt), cols[2], y + 13, { align: 'right' });
      doc.text(fmt(paid), cols[3], y + 13, { align: 'right' });
      doc.text(fmt(bal), cols[4], y + 13, { align: 'right' });
      y += 20;
    });

    y += 10;
    doc.setDrawColor(ar, ag, ab);
    doc.line(m, y, pw - m, y);
    y += 16;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ar, ag, ab);
    doc.text('TOTAL DUE', pw - m - 80, y);
    doc.text(fmt(balance), pw - m, y, { align: 'right' });

    if (data.notes) {
      y += 30;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(120, 120, 120);
      doc.text(data.notes, m, y);
    }

    doc.setFontSize(8);
    doc.setTextColor(180, 180, 180);
    doc.text('bizdockit.com', pw / 2, ph - 20, { align: 'center' });
    doc.save('statement-of-account.pdf');
  }

  return (
    <ProGate toolName="Statement of Account">
      <section className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">Pro tool</span>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">Statement of Account</h1>
          <p className="mt-2 text-slate-500">Show a client all outstanding invoices at once. Download as PDF.</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
          <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6">
            {field('Statement date', <input type="date" className={inputCls} value={data.statementDate} onChange={e => update({ statementDate: e.target.value })} />)}
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Your details</p>
              {field('Your name', <input className={inputCls} value={data.fromName} onChange={e => update({ fromName: e.target.value })} placeholder="Your Business" />)}
              {field('Your email', <input className={inputCls} value={data.fromEmail} onChange={e => update({ fromEmail: e.target.value })} placeholder="hello@yourbiz.com" />)}
            </div>
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Client details</p>
              {field('Client name', <input className={inputCls} value={data.toName} onChange={e => update({ toName: e.target.value })} placeholder="Client Name" />)}
              {field('Client company', <input className={inputCls} value={data.toCompany} onChange={e => update({ toCompany: e.target.value })} placeholder="Company" />)}
              {field('Client email', <input className={inputCls} value={data.toEmail} onChange={e => update({ toEmail: e.target.value })} placeholder="client@company.com" />)}
            </div>
            <div className="border-t border-slate-100 pt-4">
              {field('Currency', <input className={inputCls} value={data.currency} onChange={e => update({ currency: e.target.value })} placeholder="$" />)}
              {field('Notes', <textarea className={`${inputCls} resize-none`} rows={2} value={data.notes} onChange={e => update({ notes: e.target.value })} />)}
              {field('Accent colour', <input type="color" className="h-10 w-full cursor-pointer rounded-xl border border-slate-200 p-1" value={data.accentColor} onChange={e => update({ accentColor: e.target.value })} />)}
            </div>
            <button type="button" onClick={generatePdf} className="w-full rounded-2xl bg-[#0A0F1E] px-6 py-4 text-sm font-bold text-white transition hover:bg-[#1a2030]">Download PDF →</button>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Invoices</p>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="grid grid-cols-[100px_1fr_100px_100px_32px] gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest" style={{ backgroundColor: data.accentColor, color: 'white' }}>
                <span>Date</span><span>Description</span><span className="text-right">Amount</span><span className="text-right">Paid</span><span />
              </div>
              {data.rows.map((row, i) => (
                <div key={row.id} className={`grid grid-cols-[100px_1fr_100px_100px_32px] gap-2 border-t border-slate-100 px-4 py-2 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}>
                  <input type="date" className="w-full rounded border border-slate-200 px-1.5 py-1 text-xs" value={row.date} onChange={e => updateRow(row.id, 'date', e.target.value)} />
                  <input className="w-full rounded border border-slate-200 px-1.5 py-1 text-xs" value={row.description} onChange={e => updateRow(row.id, 'description', e.target.value)} placeholder="Invoice description" />
                  <input className="w-full rounded border border-slate-200 px-1.5 py-1 text-right text-xs" value={row.amount} onChange={e => updateRow(row.id, 'amount', e.target.value)} placeholder="0.00" />
                  <input className="w-full rounded border border-slate-200 px-1.5 py-1 text-right text-xs" value={row.paid} onChange={e => updateRow(row.id, 'paid', e.target.value)} placeholder="0.00" />
                  <button type="button" onClick={() => removeRow(row.id)} className="text-slate-300 hover:text-red-400">✕</button>
                </div>
              ))}
              <div className="border-t border-slate-200 px-4 py-3">
                <button type="button" onClick={addRow} className="text-sm font-semibold text-blue-600 hover:text-blue-800">+ Add row</button>
              </div>
              <div className="grid grid-cols-3 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold" style={{ color: data.accentColor }}>
                <span>Total invoiced: {fmt(totalAmount)}</span>
                <span className="text-center">Total paid: {fmt(totalPaid)}</span>
                <span className="text-right">Balance due: {fmt(balance)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </ProGate>
  );
}
