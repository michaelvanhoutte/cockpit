/**
 * A few radios drawn as one segmented control: one choice of a handful that has
 * to stay visible beside what it governs - a Filter's *All of these / Any of
 * these*, a sort's *Manual / Sorted* and each criterion's direction. `hint` is
 * what hovering an option says it means.
 */
export function Segmented<V extends string>({
  label,
  name,
  options,
  value,
  onChange,
  className = '',
}: {
  label: string;
  name: string;
  options: readonly { value: V; label: string; hint?: string }[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex rounded-md border border-black/10 p-0.5 text-sm ${className}`}
    >
      {options.map((option) => (
        <label key={option.value} className="relative" title={option.hint}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="peer sr-only"
          />
          <span className="block cursor-pointer rounded px-3 py-1 text-ink-soft peer-checked:bg-accent-tint peer-checked:font-medium peer-checked:text-accent-deep peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft/40">
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}
