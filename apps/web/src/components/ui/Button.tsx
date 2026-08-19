import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost';

export function Button({
  variant = 'primary',
  href,
  children,
  ...rest
}: {
  variant?: Variant;
  href?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `${styles.base} ${styles[variant]}`;
  if (href) {
    return (
      <a className={cls} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
