'use client';

import { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import ProGate from '@/components/ProGate';

interface DeductionRow {
  id: string;
  label: string;
  amount: string;
}

interface PayslipData {
  companyName: string;
  companyAddress: string;
  employeeName: string;
  employeeId: string;
  employeeTitle: string;
  payPeriod: string;
  payDate: string;
  basicSalary: string;
  overtime: string;
  bonus: string;
  otherEarnings: string;
  deductions: DeductionRow[];
  currency: string;
  accentColor: string;
}

const empty: PayslipData = {
  companyName: '',
  companyAddress: '',
  employeeName: '',
  employeeId: '',
  employeeTitle: '',
  payPeriod: '',
  payDate: new Date().toISOString().split('T')[0],
  basicSalary: '',
  overtime: '',
  bonus: '',
  otherEarnings: '',
  deductions: [
    { id: '1', label: 'Income Tax (PAYE)', amount: '' },
    { id: '2', label: 'UIF', amount: '' },
  ],
  currency: 'R',
  accentColor: '#0A0F1E',
};

const STORAGE_KEY = 'bizdockit_payslip_v1';
const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';

function field(label: string, el: React.ReactNode) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {el}
    </div>
  );
}

export default function PayslipGenerator() {
  const [data, setData] = useState<PayslipData>(empty);

  useEffect(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) setData(JSON.parse(s)); } catch { /* ignore */ }
  }, []);

  function update(patch: Partial<PayslipData>) {
    setData(prev => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function updateDeduction(id: string, field: 'label' | 'amount', val: string) {
    update({ deductions: data.deductions.map(d => d.id === id ? { ...d, [field]: val } : d) });
  }
  function addDeduction() {
    update({ deductions: [...data.deductions, { id: Date.now().toString(), label: '', amount: '' }] });
  }
  function removeDeduction(id: string) {
    if (data.deductions.length > 1) update({ deductions: data.deductions.filter(d => d.id !== id) });
  }

  const gross = [data.basicSalary, data.overtime, data.bonus, data.otherEarnings].reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const totalDeductions = data.deductions.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const net = gross - totalDeductions;
  const fmt = (n: number) => `${data.currency} ${n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
    doc.rect(0, 0, pw, 100, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(255, 255, 255);
    doc.text('PAYSLIP', m, 38);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(data.companyName || 'Company Name', m, 56);
    if (data.companyAddress) doc.text(data.companyAddress, m, 70);
    doc.text(`Pay date: ${data.payDate}`, pw - m, 56, { align: 'right' });
    if (data.payPeriod) doc.text(`Period: ${data.payPeriod}`, pw - m, 70, { align: 'right' });

    let y = 130;

    // Employee info box
    doc.setFillColor(248, 250, 252);
    doc.rect(m, y, pw - m * 2, 60, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(ar, ag, ab);
    doc.text('EMPLOYEE', m + 10, y + 16);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 30, 30);
    doc.text(data.employeeName || '[Employee Name]', m + 10, y + 30);
    if (data.employeeTitle) doc.text(data.employeeTitle, m + 10, y + 44);
    if (data.employeeId) doc.text(`ID: ${data.employeeId}`, pw - m - 10, y + 30, { align: 'right' });
    y += 76;

    // Earnings
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(ar, ag, ab);
    doc.text('EARNINGS', m, y);
    doc.text('DEDUCTIONS', pw / 2 + 10, y);
    y += 14;

    const earningsData = [
      { label: 'Basic salary', val: parseFloat(data.basicSalary) || 0 },
      { label: 'Overtime', val: parseFloat(data.overtime) || 0 },
      { label: 'Bonus', val: parseFloat(data.bonus) || 0 },
      { label: 'Other earnings', val: parseFloat(data.otherEarnings) || 0 },
    ].filter(e => e.val > 0);

    let ey = y;
    earningsData.forEach(({ label, val }) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(40, 40, 40);
      doc.text(label, m, ey);
      doc.text(fmt(val), pw / 2 - 10, ey, { align: 'right' });
      ey += 16;
    });

    let dy = y;
    data.deductions.filter(d => parseFloat(d.amount) > 0).forEach(d => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(40, 40, 40);
      doc.text(d.label || 'Deduction', pw / 2 + 10, dy);
      doc.text(fmt(parseFloat(d.amount) || 0), pw - m, dy, { align: 'right' });
      dy += 16;
    });

    y = Math.max(ey, dy) + 10;
    doc.setDrawColor(ar, ag, ab);
    doc.line(m, y, pw - m, y);
    y += 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ar, ag, ab);
    doc.text('GROSS PAY', m, y);
    doc.text(fmt(gross), pw / 2 - 10, y, { align: 'right' });
    doc.text('TOTAL DEDUCTIONS', pw / 2 + 10, y);
    doc.text(fmt(totalDeductions), pw - m, y, { align: 'right' });

    y += 30;
    doc.setFillColor(ar, ag, ab);
    doc.rect(m, y - 14, pw - m * 2, 30, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(255, 255, 255);
    doc.text('NET PAY', m + 10, y + 6);
    doc.text(fmt(net), pw - m - 10, y + 6, { align: 'right' });

    doc.setFontSize(7.5);
    doc.setTextColor(180, 180, 180);
    doc.text('Generated with BizDocKit Pro · bizdockit.com · This payslip is a template — not a substitute for payroll software.', pw / 2, ph - 18, { align: 'center' });

    doc.save(`payslip-${data.employeeName || 'employee'}.pdf`);
  }

  return (
    <ProGate toolName="Payslip Generator">
      <section className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">Pro tool</span>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">Payslip Generator</h1>
          <p className="mt-2 text-slate-500">Create a payslip for an employee. Download as PDF. <span className="font-semibold text-amber-600">Template only — not a substitute for payroll software.</span></p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[400px_1fr]">
          <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6">
            <div>
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Company</p>
              {field('Company name', <input className={inputCls} value={data.companyName} onChange={e => update({ companyName: e.target.value })} placeholder="Your Company" />)}
              {field('Company address', <input className={inputCls} value={data.companyAddress} onChange={e => update({ companyAddress: e.target.value })} placeholder="123 Main St, Johannesburg" />)}
            </div>
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Employee</p>
              {field('Employee name', <input className={inputCls} value={data.employeeName} onChange={e => update({ employeeName: e.target.value })} placeholder="John Employee" />)}
              {field('Job title', <input className={inputCls} value={data.employeeTitle} onChange={e => update({ employeeTitle: e.target.value })} placeholder="Senior Designer" />)}
              {field('Employee ID', <input className={inputCls} value={data.employeeId} onChange={e => update({ employeeId: e.target.value })} placeholder="EMP-001" />)}
            </div>
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Pay period</p>
              <div className="grid grid-cols-2 gap-3">
                {field('Pay period', <input className={inputCls} value={data.payPeriod} onChange={e => update({ payPeriod: e.target.value })} placeholder="January 2025" />)}
                {field('Pay date', <input type="date" className={inputCls} value={data.payDate} onChange={e => update({ payDate: e.target.value })} />)}
              </div>
              {field('Currency', <input className={inputCls} value={data.currency} onChange={e => update({ currency: e.target.value })} placeholder="R" />)}
            </div>
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Earnings</p>
              {field('Basic salary', <input className={inputCls} value={data.basicSalary} onChange={e => update({ basicSalary: e.target.value })} placeholder="0.00" />)}
              {field('Overtime', <input className={inputCls} value={data.overtime} onChange={e => update({ overtime: e.target.value })} placeholder="0.00" />)}
              {field('Bonus', <input className={inputCls} value={data.bonus} onChange={e => update({ bonus: e.target.value })} placeholder="0.00" />)}
              {field('Other earnings', <input className={inputCls} value={data.otherEarnings} onChange={e => update({ otherEarnings: e.target.value })} placeholder="0.00" />)}
            </div>
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Deductions</p>
              <div className="space-y-2">
                {data.deductions.map(d => (
                  <div key={d.id} className="grid grid-cols-[1fr_100px_28px] gap-2">
                    <input className={inputCls} value={d.label} onChange={e => updateDeduction(d.id, 'label', e.target.value)} placeholder="Deduction name" />
                    <input className={inputCls} value={d.amount} onChange={e => updateDeduction(d.id, 'amount', e.target.value)} placeholder="0.00" />
                    <button type="button" onClick={() => removeDeduction(d.id)} className="text-slate-300 hover:text-red-400">✕</button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={addDeduction} className="mt-2 text-sm font-semibold text-blue-600 hover:text-blue-800">+ Add deduction</button>
            </div>
            {field('Accent colour', <input type="color" className="h-10 w-full cursor-pointer rounded-xl border border-slate-200 p-1" value={data.accentColor} onChange={e => update({ accentColor: e.target.value })} />)}
            <button type="button" onClick={generatePdf} className="w-full rounded-2xl bg-[#0A0F1E] px-6 py-4 text-sm font-bold text-white transition hover:bg-[#1a2030]">Download Payslip PDF →</button>
          </div>

          {/* Preview */}
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Preview</p>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-8 py-5" style={{ backgroundColor: data.accentColor }}>
                <div className="flex justify-between">
                  <div>
                    <p className="text-xl font-black text-white">PAYSLIP</p>
                    <p className="text-sm text-white/70">{data.companyName || 'Company Name'}</p>
                  </div>
                  <div className="text-right text-sm text-white/70">
                    <p>{data.payDate}</p>
                    {data.payPeriod && <p>{data.payPeriod}</p>}
                  </div>
                </div>
              </div>
              <div className="bg-slate-50 px-8 py-4">
                <p className="font-bold text-slate-900">{data.employeeName || 'Employee Name'}</p>
                <p className="text-sm text-slate-500">{data.employeeTitle || 'Job Title'} {data.employeeId && `· ${data.employeeId}`}</p>
              </div>
              <div className="grid grid-cols-2 divide-x divide-slate-100 px-8 py-5">
                <div className="pr-6">
                  <p className="mb-3 text-xs font-bold uppercase tracking-widest" style={{ color: data.accentColor }}>Earnings</p>
                  {[
                    { label: 'Basic salary', val: data.basicSalary },
                    { label: 'Overtime', val: data.overtime },
                    { label: 'Bonus', val: data.bonus },
                    { label: 'Other', val: data.otherEarnings },
                  ].filter(e => parseFloat(e.val) > 0).map(e => (
                    <div key={e.label} className="flex justify-between text-sm">
                      <span className="text-slate-500">{e.label}</span>
                      <span className="font-semibold">{fmt(parseFloat(e.val))}</span>
                    </div>
                  ))}
                  <div className="mt-2 border-t border-slate-100 pt-2 flex justify-between text-sm font-bold" style={{ color: data.accentColor }}>
                    <span>Gross</span><span>{fmt(gross)}</span>
                  </div>
                </div>
                <div className="pl-6">
                  <p className="mb-3 text-xs font-bold uppercase tracking-widest" style={{ color: data.accentColor }}>Deductions</p>
                  {data.deductions.filter(d => parseFloat(d.amount) > 0).map(d => (
                    <div key={d.id} className="flex justify-between text-sm">
                      <span className="text-slate-500">{d.label || 'Deduction'}</span>
                      <span className="font-semibold">{fmt(parseFloat(d.amount))}</span>
                    </div>
                  ))}
                  <div className="mt-2 border-t border-slate-100 pt-2 flex justify-between text-sm font-bold" style={{ color: data.accentColor }}>
                    <span>Total</span><span>{fmt(totalDeductions)}</span>
                  </div>
                </div>
              </div>
              <div className="px-8 py-4 text-white" style={{ backgroundColor: data.accentColor }}>
                <div className="flex justify-between text-lg font-black">
                  <span>NET PAY</span><span>{fmt(net)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </ProGate>
  );
}
