'use client';

/** Opens the browser's print dialog, which also offers "Save as PDF" on every common device. */
export function PrintButton() {
  return (
    <button type="button" className="rk-btn rk-no-print" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
