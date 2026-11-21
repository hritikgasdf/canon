import { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, { Button, Inline, Lozenge, SectionMessage, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

type Procedure = {
  controlled: boolean;
  currentApproved: number | null;
  lastSeenVersion: number;
  policy: string;
};

type BylineState = {
  ok: true;
  procedure: Procedure | null;
  openBindings: number;
  pendingDraft: boolean;
  liveVersion: number;
};

type Failure = { ok: false; error: string; message: string };

type MarkResult = { ok: true; procedure: Procedure };

type ApproveResult = {
  ok: true;
  procedure: Procedure;
  supersede: { superseded: string[]; skipped: string[] } | null;
};

// invoke() types its result as T | {body, metadata}; resolvers return T directly
// unless they attach metadata, so unwrap `body` only when that wrapper is present.
async function call<T>(name: string, payload: object): Promise<T> {
  const res = await invoke<T>(name, payload);
  if (typeof res === 'object' && res !== null && 'body' in res && !('ok' in res)) {
    return (res as { body: T }).body;
  }
  return res as T;
}

function friendly(f: Failure): string {
  switch (f.error) {
    case 'SELF_APPROVAL':
      return 'You edited this version — another approver must approve it.';
    case 'NO_ACCESS':
      return "Canon can't read this page. Ask an admin to give the Canon app access to this space.";
    case 'NOT_LATEST':
      return 'The page changed — refresh and try again.';
    default:
      return f.message;
  }
}

const App = () => {
  const [state, setState] = useState<BylineState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await call<BylineState | Failure>('canonBylineState', {});
      if (res.ok) {
        setState(res);
      } else {
        setError(friendly(res));
      }
    } catch {
      setError('Canon could not load this page. Try again.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch {
      setError('Canon could not complete this request. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const markControlled = () =>
    run(async () => {
      const res = await call<MarkResult | Failure>('canonMarkControlled', {});
      if (!res.ok) {
        setError(friendly(res));
        return;
      }
      await load();
    });

  const approve = (version: number) =>
    run(async () => {
      const res = await call<ApproveResult | Failure>('canonApprove', { version });
      if (!res.ok) {
        setError(friendly(res));
        return;
      }
      if (res.supersede) {
        const count = res.supersede.superseded.length;
        setNotice(`Approved v${version}; ${count} tickets need re-attestation`);
      }
      await load();
    });

  const proc = state?.procedure ?? null;
  const live = state?.liveVersion ?? 0;
  const approved = proc?.currentApproved ?? null;
  const pending = live > (approved ?? 0);

  let body = null;
  if (state) {
    if (!proc || !proc.controlled) {
      body = (
        <Inline space="space.100">
          <Text>Canon · not controlled</Text>
          <Button isDisabled={busy} onClick={markControlled}>
            Mark as controlled
          </Button>
        </Inline>
      );
    } else if (approved === null) {
      body = (
        <Inline space="space.100">
          <Text>Canon · controlled · no approved version</Text>
          <Button appearance="primary" isDisabled={busy} onClick={() => approve(live)}>
            {`Approve v${live}`}
          </Button>
        </Inline>
      );
    } else {
      body = (
        <Inline space="space.100">
          <Lozenge appearance="success">{`Approved v${approved}`}</Lozenge>
          <Text>{`${state.openBindings} bound tickets`}</Text>
          {pending && (
            <>
              <Lozenge appearance="moved">{`Draft v${live} pending`}</Lozenge>
              <Button appearance="primary" isDisabled={busy} onClick={() => approve(live)}>
                {`Approve v${live}`}
              </Button>
            </>
          )}
        </Inline>
      );
    }
  }

  return (
    <Stack space="space.100">
      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {notice && (
        <SectionMessage appearance="success">
          <Text>{notice}</Text>
        </SectionMessage>
      )}
      {body ?? <Text>Canon · loading…</Text>}
    </Stack>
  );
};

ForgeReconciler.render(<App />);
