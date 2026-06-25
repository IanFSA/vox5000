'use client';

import { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import ProGate from '@/components/ProGate';

interface ExpenseRow {
  id: string;
  date: string;
  description: string;
  category: string;
  amount: string;
  receipt: string;
}

const CATEGORIES = ['Travel', 'Meals', 'Equipment', 'Software', 'Marketing', 'Office', 'Professional fees', 'Utilities', 'Other'];
const STORAGE_KEY = 'bizdockit_expenses_v1';

const emptyRow = (): ExpenseRow => ({ id: Date.now().toString(), date: '', description: '', category: 'Other', amount: '', receipt: '' });

interface ExpenseState {
  businessName: string;
  period: string;
  currency: string;
  accentColor: string;
  rows: ExpenseRow[];
}

const empty: ExpenseState = {
  businessName: '',
  period: '',
  currency: '$',
  accentColor: '#2563EB',
  rows: [emptyRow()],
};

const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';

export default function ExpenseTracker() {
  const [data, setData] = useState<ExpenseState>(empty);

  useEffect(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) setData(JSON.parse(s)); } catch { /* ignore */ }
  }, []);

  function update(patch: Partial<ExpenseState>) {
    setData(prev => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function updateRow(id: string, field: keyof ExpenseRow, val: string) {
    update({ rows: data.rows.map(r => r.id === id ? { ...r, [field]: val } : r) });
  }

  function addRow() { update({ rows: [...data.rows, emptyRow()] }); }
  function removeRow(id: string) { if (data.rows.length > 1) update({ rows: data.rows.filter(r => r.id !== id) }); }

  const total = data.rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const fmt = (n: number) => `${data.currency}${n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Category totals
  const byCategory = CATEGORIES.map(cat => ({
    cat,
    total: data.rows.filter(r => r.category === cat).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
  })).filter(c => c.total > 0);

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
    doc.setFontSize(20);
    doc.setTextColor(255, 255, 255);
    doc.text('EXPENSE REPORT', m, 38);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    if (data.businessName) doc.text(data.businessName, m, 56);
    if (data.period) doc.text(`Period: ${data.period}`, m, 72);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, pw - m, 60, { align: 'right' });
    doc.text(`Total: ${fmt(total)}`, pw - m, 76, { align: 'right' });

    let y = 110;

    // Category summary
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(ar, ag, ab);
    doc.text('SUMMARY BY CATEGORY', m, y);
    y += 14;
    byCategory.forEach(({ cat, total: t }) => {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      doc.text(cat, m, y);
      doc.text(fmt(t), pw - m, y, { align: 'right' });
      y += 13;
    });
    y += 10;

    // Table
    doc.setFillColor(ar, ag, ab);
    doc.rect(m, y, pw - m * 2, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text('DATE', m + 4, y + 14);
    doc.text('DESCRIPTION', m + 80, y + 14);
    doc.text('CATEGORY', m + 240, y + 14);
    doc.text('RECEIPT', pw - 110, y + 14);
    doc.text('AMOUNT', pw - m - 4, y + 14, { align: 'right' });
    y += 22;

    data.rows.forEach((row, i) => {
      if (y > ph - 80) { doc.addPage(); y = 48; }
      if (i % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(m, y, pw - m * 2, 20, 'F'); }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(50, 50, 50);
      doc.text(row.date || '—', m + 4, y + 13);
      doc.text(row.description || '—', m + 80, y + 13);
      doc.text(row.category, m + 240, y + 13);
      doc.text(row.receipt || '—', pw - 110, y + 13);
      doc.text(fmt(parseFloat(row.amount) || 0), pw - m - 4, y + 13, { align: 'right' });
      y += 20;
    });

    y += 8;
    doc.setDrawColor(ar, ag, ab);
    doc.line(m, y, pw - m, y);
    y += 14;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(ar, ag, ab);
    doc.text('TOTAL', m, y);
    doc.text(fmt(total), pw - m, y, { align: 'right' });

    doc.setFontSize(8);
    doc.setTextColor(180, 180, 180);
    doc.text('bizdockit.com', pw / 2, ph - 20, { align: 'center' });
    doc.save('expense-report.pdf');
  }

  return (
    <ProGate toolName="Expense Tracker">
      <section className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">Pro tool</span>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">Expense Tracker</h1>
          <p className="mt-2 text-slate-500">Log your business expenses by category and export a clean PDF report.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* Settings sidebar */}
          <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Report settings</p>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Business name</label>
              <input className={inputCls} value={data.businessName} onChange={e => update({ businessName: e.target.value })} placeholder="Your Business" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Period</label>
              <input className={inputCls} value={data.period} onChange={e => update({ period: e.target.value })} placeholder="January 2025" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Currency</label>
              <input className={inputCls} value={data.currency} onChange={e => update({ currency: e.target.value })} placeholder="$" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Accent colour</label>
              <input type="color" className="h-10 w-full cursor-pointer rounded-xl border border-slate-200 p-1" value={data.accentColor} onChange={e => update({ accentColor: e.target.value })} />
            </div>

            {/* Category summary */}
            {byCategory.length > 0 && (
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">By category</p>
                <div className="space-y-2">
                  {byCategory.map(({ cat, total: t }) => (
                    <div key={cat} className="flex justify-between text-xs">
                      <span className="text-slate-600">{cat}</span>
                      <span className="font-semibold text-slate-900">{fmt(t)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-2xl border-2 p-4 text-center" style={{ borderColor: data.accentColor }}>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Total</p>
              <p className="mt-1 text-2xl font-black" style={{ color: data.accentColor }}>{fmt(total)}</p>
            </div>

            <button type="button" onClick={generatePdf} className="w-full rounded-2xl bg-[#0A0F1E] px-6 py-4 text-sm font-bold text-white transition hover:bg-[#1a2030]">
              Export PDF →
            </button>
          </div>

          {/* Expense table */}
          <div className="rounded-3xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ backgroundColor: data.accentColor }}>
                    {['Date', 'Description', 'Category', 'Receipt ref', 'Amount', ''].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-widest text-white">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr key={row.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                      <td className="px-3 py-2">
                        <input type="date" className="w-full rounded border border-slate-200 px-2 py-1 text-xs" value={row.date} onChange={e => updateRow(row.id, 'date', e.target.value)} />
                      </td>
                      <td className="px-3 py-2">
                        <input className="w-full rounded border border-slate-200 px-2 py-1 text-xs" value={row.description} onChange={e => updateRow(row.id, 'description', e.target.value)} placeholder="Description" />
                      </td>
                      <td className="px-3 py-2">
                        <select className="w-full rounded border border-slate-200 px-2 py-1 text-xs" value={row.category} onChange={e => updateRow(row.id, 'category', e.target.value)}>
                          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input className="w-full rounded border border-slate-200 px-2 py-1 text-xs" value={row.receipt} onChange={e => updateRow(row.id, 'receipt', e.target.value)} placeholder="Ref #" />
                      </td>
                      <td className="px-3 py-2">
                        <input className="w-32 rounded border border-slate-200 px-2 py-1 text-right text-xs" value={row.amount} onChange={e => updateRow(row.id, 'amount', e.target.value)} placeholder="0.00" />
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeRow(row.id)} className="text-slate-300 hover:text-red-400">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-3">
              <button type="button" onClick={addRow} className="text-sm font-semibold text-blue-600 hover:text-blue-800">+ Add expense</button>
            </div>
          </div>
        </div>
      </section>
    </ProGate>
  );
}
