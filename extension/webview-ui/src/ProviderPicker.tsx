import {useEffect, useId, useRef, useState} from "react";

const providers = ["DeepSeek", "OpenRouter"];

export function ProviderPicker({value, onChange, disabled, above = false}: {
  value: string; onChange: (value: string) => void; disabled: boolean; above?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  function show() {
    setActive(Math.max(0, providers.indexOf(value)));
    setOpen(true);
  }
  function choose(index: number) {
    onChange(providers[index]);
    setOpen(false);
    trigger.current?.focus();
  }

  return <div className={"provider-picker" + (above ? " above" : "")} ref={root}>
    <button type="button" ref={trigger} role="combobox" aria-label={"Provider: " + value}
      aria-haspopup="listbox" aria-controls={expanded ? id : undefined} aria-expanded={expanded}
      aria-activedescendant={expanded ? id + active : undefined} disabled={disabled}
      onBlur={() => setOpen(false)} onClick={() => expanded ? setOpen(false) : show()}
      onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!expanded) show();
          else setActive((active + (e.key === "ArrowDown" ? 1 : -1) + providers.length) % providers.length);
        } else if (expanded && ["Home", "End", "Enter", " ", "Escape"].includes(e.key)) {
          e.preventDefault();
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "Home" || e.key === "End") setActive(e.key === "Home" ? 0 : providers.length - 1);
          else choose(active);
        }
      }}>{value}<span aria-hidden="true" className="provider-chevron"/></button>
    {expanded && <div className="provider-menu" id={id} role="listbox" aria-label="Provider">
      {providers.map((name,i) => <div key={name} id={id+i} role="option" aria-selected={name===value}
        className={i===active ? "active" : ""} onPointerMove={()=>setActive(i)}
        onMouseDown={e=>e.preventDefault()} onClick={()=>choose(i)}>
        {name}{name===value && <span aria-hidden="true">✓</span>}
      </div>)}
    </div>}
  </div>;
}
