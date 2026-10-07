/**
 * The setup step's field: where the learner hands the plugin their colleague's
 * account token.
 *
 * This is the one piece of configuration Course 3 needs, and it is deliberately a
 * step of its own rather than a line buried in Step 2 — the learner comes back to
 * it (a token can be pasted wrong, or the colleague's account can change), and a
 * course step is easy to find again.
 *
 * It is also the one place the course says where the token is kept, and on what
 * terms — see colleagueIdentity.ts. Said once, here, and not repeated at every
 * step that acts for her.
 *
 * Checking the token is not a formality. Pasting YOUR OWN token instead of hers is
 * the natural mistake, and nothing would complain: the plugin would simply act as
 * you, and the colleague would mysteriously sign every edit with the learner's own
 * name — three steps later, with no clue as to why. So the field confirms out loud
 * WHO the credential belongs to, with the account's real name and avatar, and
 * leaves the learner to recognise their colleague or spot themselves.
 */

import { t } from '../../../locale/t';
import React, { useEffect, useState } from 'react';
import {
  clearColleagueToken,
  getColleagueToken,
  setColleagueToken,
} from '../../../utils/custom-utils/colleagueIdentity';
import { ColleagueAccount, colleagueAccountInfo } from '../../../utils/custom-utils/colleagueRead';

const S: Record<string, React.CSSProperties> = {
  wrap: { marginTop: 14 },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    minWidth: 0,
    padding: '7px 10px',
    border: '1px solid #ced4da',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  button: {
    padding: '7px 14px',
    borderRadius: 6,
    border: 'none',
    background: '#ff8000',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: '#6c757d',
    fontSize: 'inherit',
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
    whiteSpace: 'nowrap',
  },
  card: {
    marginTop: 12,
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #e3e6ea',
  },
  avatar: { width: 36, height: 36, borderRadius: '50%', flexShrink: 0 },
  // One size throughout — the page's own — and one grey for everything that is not
  // her name. Success is said ONCE, by the step's own status line below the widget;
  // a green "All set" here only repeated it louder.
  name: {},
  sub: { color: '#6c757d' },
  error: { marginTop: 12, color: '#b02a37' },
  note: { marginTop: 10, color: '#6c757d', lineHeight: 1.5 },
};

interface Props {
  /** Told to the parent so the step can mark itself done. */
  onVerified?: (account: ColleagueAccount) => void;
}

const ColleagueSetup: React.FC<Props> = ({ onVerified }) => {
  const [value, setValue] = useState('');
  const [account, setAccount] = useState<ColleagueAccount | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A token stored on a previous visit should verify itself, so coming back to
  // this step shows who is configured instead of an empty field.
  useEffect(() => {
    if (!getColleagueToken()) return;
    let cancelled = false;
    colleagueAccountInfo()
      .then((acc) => {
        if (cancelled) return;
        setAccount(acc);
        onVerified?.(acc);
      })
      .catch(() => {
        if (!cancelled) setError(t('colleague_setup.stored_rejected'));
      });
    return () => {
      cancelled = true;
    };
    // Runs once on mount: re-checking on every render would hammer the endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async () => {
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError('');
    setAccount(null);
    setColleagueToken(token);
    try {
      const acc = await colleagueAccountInfo();
      setAccount(acc);
      setValue('');
      onVerified?.(acc);
    } catch {
      // Store nothing that does not work: a bad token left behind would fail
      // later, in a step that has no idea why.
      clearColleagueToken();
      setError(t('colleague_setup.rejected'));
    }
    setBusy(false);
  };

  const forget = () => {
    clearColleagueToken();
    setAccount(null);
    setValue('');
    setError('');
  };

  if (account) {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          {account.avatarUrl && <img src={account.avatarUrl} alt="" style={S.avatar} />}
          <div>
            <div style={S.name}>{account.name || t('colleague_setup.no_name')}</div>
            <div style={S.sub}>{account.contactEmail || account.email}</div>
          </div>
        </div>
        <div style={{ ...S.note, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>{t('colleague_setup.is_this_her')}</span>
          <button type="button" style={S.linkButton} onClick={forget}>
            {t('colleague_setup.use_another')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      <div style={S.row}>
        <input
          type="password"
          style={S.input}
          value={value}
          placeholder={t('colleague_setup.placeholder')}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') check();
          }}
        />
        <button type="button" style={S.button} onClick={check} disabled={busy || !value.trim()}>
          {busy ? t('colleague_setup.checking') : t('course.check')}
        </button>
      </div>
      {error && <div style={S.error}>{error}</div>}
      <div style={S.note}>{t('colleague_setup.storage_note')}</div>
    </div>
  );
};

export default ColleagueSetup;
