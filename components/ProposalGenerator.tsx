'use client';

import { useEffect, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import ProGate from '@/components/ProGate';

interface ProposalData {
  proposalNumber: string;
  date: string;
  validUntil: string;
  fromName: string;
  fromEmail: string;
  fromPhone: string;
  fromAddress: string;
  toName: string;
  toCompany: string;
  toEmail: string;
  projectTitle: string;
  overview: string;
  scope: string;
  deliverables: string;
  timeline: string;
  investment: string;
  terms: string;
  accentColor: string;
}

const empty: ProposalData = {
  proposalNumber: 'PROP-001',
  date: new Date().toISOString().split('T')[0],
  validUntil: '',
  fromName: '',
  fromEmail: '',
  fromPhone: '',
  fromAddress: '',
  toName: '',
  toCompany: '',
  toEmail: '',
  projectTitle: '',
  overview: '',
  scope: '',
  deliverables: '',
  timeline: '',
  investment: '',
  terms: 'This proposal is valid for 30 days from the date above. A 50% deposit is required to begin work.',
  accentColor: '#2563EB',
};

const STORAGE_KEY = 'bizdockit_proposal_v1';

function field(label: string, el: React.ReactNode) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {el}
    </div>
  );
}

const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';
const textareaCls = inputCls + ' resize-none';

export default function ProposalGenerator() {
  const [data, setData] = useState<ProposalData>(empty);
  const logoRef = useRef<HTMLInputElement>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) setData(JSON.parse(s));
    } catch { /* ignore */ }
  }, []);

  function set<K extends keyof ProposalData>(k: K, v: ProposalData[K]) {
    setData(prev => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function handleLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setLogoDataUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  function generatePdf() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 48;
    const cw = pw - m * 2;
    const accent = data.accentColor || '#2563EB';

    function hexToRgb(hex: string): [number, number, number] {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return [r, g, b];
    }

    const [ar, ag, ab] = hexToRgb(accent);

    // Header band
    doc.setFillColor(ar, ag, ab);
    doc.rect(0, 0, pw, 100, 'F');

    // Logo or business name in header
    if (logoDataUrl) {
      try { doc.addImage(logoDataUrl, 'PNG', m, 22, 60, 56); } catch { /* ignore */ }
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(255, 255, 255);
    doc.text('PROPOSAL', pw - m, 42, { align: 'right' });

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(data.proposalNumber || 'PROP-001', pw - m, 60, { align: 'right' });
    doc.text(`Date: ${data.date}`, pw - m, 75, { align: 'right' });
    if (data.validUntil) doc.text(`Valid until: ${data.validUntil}`, pw - m, 90, { align: 'right' });

    // From / To
    let y = 130;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(ar, ag, ab);
    doc.text('FROM', m, y);
    doc.text('PREPARED FOR', pw / 2 + 10, y);

    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(10);

    const fromLines = [data.fromName, data.fromEmail, data.fromPhone, data.fromAddress].filter(Boolean);
    fromLines.forEach(line => { doc.text(line, m, y); y += 14; });

    let y2 = 144;
    const toLines = [data.toName, data.toCompany, data.toEmail].filter(Boolean);
    toLines.forEach(line => { doc.text(line, pw / 2 + 10, y2); y2 += 14; });

    y = Math.max(y, y2) + 20;

    // Divider
    doc.setDrawColor(220, 220, 220);
    doc.line(m, y, pw - m, y);
    y += 20;

    // Project title
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(ar, ag, ab);
    doc.text(data.projectTitle || 'Project Title', m, y);
    y += 28;

    function section(title: string, body: string) {
      if (!body.trim()) return;
      if (y > ph - 120) { doc.addPage(); y = 48; }
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(ar, ag, ab);
      doc.text(title.toUpperCase(), m, y);
      y += 14;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      doc.setFontSize(10);
      const lines = doc.splitTextToSize(body, cw);
      lines.forEach((line: string) => {
        if (y > ph - 60) { doc.addPage(); y = 48; }
        doc.text(line, m, y);
        y += 14;
      });
      y += 10;
    }

    section('Project Overview', data.overview);
    section('Scope of Work', data.scope);
    section('Deliverables', data.deliverables);
    section('Timeline', data.timeline);
    section('Investment', data.investment);
    section('Terms & Conditions', data.terms);

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(180, 180, 180);
    doc.text('bizdockit.com', pw / 2, ph - 20, { align: 'center' });

    doc.save(`${data.proposalNumber || 'proposal'}.pdf`);
  }

  return (
    <ProGate toolName="Proposal Generator">
      <section className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">Pro tool</span>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">Proposal Generator</h1>
          <p className="mt-2 text-slate-500">Create a professional project proposal and download it as a PDF.</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[420px_1fr]">
          {/* Form */}
          <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Your details</p>
            {field('Your name', <input className={inputCls} value={data.fromName} onChange={e => set('fromName', e.target.value)} placeholder="Jane Smith" />)}
            {field('Your email', <input className={inputCls} value={data.fromEmail} onChange={e => set('fromEmail', e.target.value)} placeholder="jane@yourbiz.com" />)}
            {field('Your phone', <input className={inputCls} value={data.fromPhone} onChange={e => set('fromPhone', e.target.value)} placeholder="+27 82 000 0000" />)}
            {field('Your address', <textarea className={textareaCls} rows={2} value={data.fromAddress} onChange={e => set('fromAddress', e.target.value)} placeholder="123 Main St, Johannesburg" />)}

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Client details</p>
              {field('Client name', <input className={inputCls} value={data.toName} onChange={e => set('toName', e.target.value)} placeholder="John Client" />)}
              {field('Client company', <input className={inputCls} value={data.toCompany} onChange={e => set('toCompany', e.target.value)} placeholder="Acme Corp" />)}
              {field('Client email', <input className={inputCls} value={data.toEmail} onChange={e => set('toEmail', e.target.value)} placeholder="john@acme.com" />)}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Proposal details</p>
              {field('Proposal number', <input className={inputCls} value={data.proposalNumber} onChange={e => set('proposalNumber', e.target.value)} placeholder="PROP-001" />)}
              <div className="grid grid-cols-2 gap-3">
                {field('Date', <input type="date" className={inputCls} value={data.date} onChange={e => set('date', e.target.value)} />)}
                {field('Valid until', <input type="date" className={inputCls} value={data.validUntil} onChange={e => set('validUntil', e.target.value)} />)}
              </div>
              {field('Project title', <input className={inputCls} value={data.projectTitle} onChange={e => set('projectTitle', e.target.value)} placeholder="Website Redesign for Acme Corp" />)}
              {field('Project overview', <textarea className={textareaCls} rows={3} value={data.overview} onChange={e => set('overview', e.target.value)} placeholder="A brief summary of the project and what you'll deliver." />)}
              {field('Scope of work', <textarea className={textareaCls} rows={4} value={data.scope} onChange={e => set('scope', e.target.value)} placeholder="What is included. Be specific." />)}
              {field('Deliverables', <textarea className={textareaCls} rows={3} value={data.deliverables} onChange={e => set('deliverables', e.target.value)} placeholder="List of items you will hand over." />)}
              {field('Timeline', <textarea className={textareaCls} rows={2} value={data.timeline} onChange={e => set('timeline', e.target.value)} placeholder="e.g. 4 weeks from deposit payment." />)}
              {field('Investment', <textarea className={textareaCls} rows={2} value={data.investment} onChange={e => set('investment', e.target.value)} placeholder="e.g. R 15,000 total. 50% deposit required." />)}
              {field('Terms', <textarea className={textareaCls} rows={3} value={data.terms} onChange={e => set('terms', e.target.value)} />)}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Settings</p>
              {field('Accent colour', <input type="color" className="h-10 w-full cursor-pointer rounded-xl border border-slate-200 p-1" value={data.accentColor} onChange={e => set('accentColor', e.target.value)} />)}
              {field('Logo (optional)', <input ref={logoRef} type="file" accept="image/*" className="w-full text-sm text-slate-600" onChange={handleLogo} />)}
            </div>

            <button
              type="button"
              onClick={generatePdf}
              className="w-full rounded-2xl bg-[#0A0F1E] px-6 py-4 text-sm font-bold text-white transition hover:bg-[#1a2030]"
            >
              Download PDF →
            </button>
          </div>

          {/* Preview */}
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Preview</p>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {/* Header */}
              <div className="px-8 py-6" style={{ backgroundColor: data.accentColor }}>
                <div className="flex items-start justify-between">
                  <div>
                    {logoDataUrl && <img src={logoDataUrl} alt="Logo" className="mb-2 h-10 object-contain" />}
                    <p className="text-sm text-white/70">{data.fromName || 'Your Name'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-black text-white">PROPOSAL</p>
                    <p className="text-sm text-white/70">{data.proposalNumber || 'PROP-001'}</p>
                    <p className="text-xs text-white/60">{data.date}</p>
                  </div>
                </div>
              </div>

              {/* From / To */}
              <div className="grid grid-cols-2 gap-4 border-b border-slate-100 px-8 py-5">
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest" style={{ color: data.accentColor }}>From</p>
                  <p className="text-sm font-semibold text-slate-900">{data.fromName || '—'}</p>
                  <p className="text-xs text-slate-500">{data.fromEmail}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest" style={{ color: data.accentColor }}>Prepared for</p>
                  <p className="text-sm font-semibold text-slate-900">{data.toName || '—'}</p>
                  <p className="text-xs text-slate-500">{data.toCompany}</p>
                </div>
              </div>

              {/* Project title */}
              <div className="border-b border-slate-100 px-8 py-5">
                <p className="text-xl font-bold" style={{ color: data.accentColor }}>{data.projectTitle || 'Project Title'}</p>
              </div>

              {/* Sections */}
              <div className="space-y-4 px-8 py-5">
                {[
                  { label: 'Overview', val: data.overview },
                  { label: 'Scope', val: data.scope },
                  { label: 'Deliverables', val: data.deliverables },
                  { label: 'Timeline', val: data.timeline },
                  { label: 'Investment', val: data.investment },
                  { label: 'Terms', val: data.terms },
                ].map(({ label, val }) => val ? (
                  <div key={label}>
                    <p className="mb-1 text-xs font-bold uppercase tracking-widest" style={{ color: data.accentColor }}>{label}</p>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-slate-600">{val}</p>
                  </div>
                ) : null)}
              </div>

              <div className="border-t border-slate-100 px-8 py-3 text-center text-xs text-slate-300">
                bizdockit.com
              </div>
            </div>
          </div>
        </div>
      </section>
    </ProGate>
  );
}
