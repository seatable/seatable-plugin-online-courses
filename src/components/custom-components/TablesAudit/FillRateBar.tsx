import React from 'react';

interface FillRateBarProps {
  rate: number | null;
}

function getColor(rate: number): string {
  if (rate >= 0.8) return '#28a745';
  if (rate >= 0.4) return '#ffc107';
  return '#dc3545';
}

const FillRateBar: React.FC<FillRateBarProps> = ({ rate }) => {
  if (rate === null) return <span className="text-muted">N/A</span>;

  const pct = Math.round(rate * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width: 120,
          height: 16,
          backgroundColor: '#e9ecef',
          borderRadius: 4,
          overflow: 'hidden',
        }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: getColor(rate),
            borderRadius: 4,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span style={{ fontSize: 13, minWidth: 36, color: '#555' }}>{pct}%</span>
    </div>
  );
};

export default FillRateBar;
