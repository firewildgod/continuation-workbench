import { Children, cloneElement, isValidElement, useId } from 'react';
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Button({ children, icon, tone, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; tone?: 'primary' | 'soft' | 'ghost' | 'danger'; }) {
  return <button {...props} className={`btn ${tone ? `btn-${tone}` : ''} ${className}`}>{icon && <Icon name={icon} />}{children}</button>;
}

export function Pill({ children, tone = '' }: { children: ReactNode; tone?: '' | 'success' | 'warning' | 'error' | 'info' }) {
  return <span className={`status-pill ${tone}`}><span className="dot" />{children}</span>;
}

export function Panel({ title, icon, actions, children, className = '' }: { title?: string; icon?: IconName; actions?: ReactNode; children: ReactNode; className?: string; }) {
  return <section className={`panel ${className}`}>{title && <div className="panel-header"><h2 className="panel-title">{icon && <Icon name={icon} />}{title}</h2>{actions}</div>}{children}</section>;
}

export function Empty({ icon = 'work', title, description, children }: { icon?: IconName; title: string; description: string; children?: ReactNode; }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} /></div><h3>{title}</h3><p>{description}</p>{children && <div style={{ marginTop: 18 }}>{children}</div>}</div>;
}

export function Notice({ children, title, tone = '', icon = 'info' }: { children?: ReactNode; title: string; tone?: '' | 'warning' | 'neutral'; icon?: IconName; }) {
  return <div className={`notice ${tone}`}><Icon name={icon} /><div><strong>{title}</strong>{children && <p>{children}</p>}</div></div>;
}

export function Field({ label, hint, full = false, children }: { label: string; hint?: string; full?: boolean; children: ReactNode; }) {
  const id = useId();
  const controlId = `control-${id}`;
  const labelId = `label-${id}`;
  const hintId = `hint-${id}`;
  const attachLabel = (nodes: ReactNode): ReactNode => Children.map(nodes, (node) => {
    if (!isValidElement(node)) return node;
    const element = node as ReactElement<{ children?: ReactNode; id?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string }>;
    if (typeof element.type === 'string' && ['input', 'select', 'textarea'].includes(element.type)) return cloneElement(element, { id: element.props.id || controlId, 'aria-labelledby': labelId, 'aria-describedby': hint ? hintId : undefined });
    if (typeof element.type === 'string' && element.props.children) return cloneElement(element, { children: attachLabel(element.props.children) });
    return element;
  });
  return <div className={`field ${full ? 'full' : ''}`}><label id={labelId} htmlFor={controlId}>{label}</label>{attachLabel(children)}{hint && <small id={hintId}>{hint}</small>}</div>;
}
