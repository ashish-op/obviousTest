export interface DataValueProps {
  label: string;
  value: string | number;
  unit?: string;
}

/**
 * LCARS data readout — ice-blue numeric with a muted uppercase label.
 * Presentational only: props in, markup out; no fetching, no state.
 */
export function DataValue({ label, value, unit }: DataValueProps) {
  return (
    <div className="lcars-data-value">
      <span className="lcars-data-value__label">{label}</span>
      <span className="lcars-data-value__value">
        {value}
        {unit ? <span className="lcars-data-value__unit">{unit}</span> : null}
      </span>
    </div>
  );
}
