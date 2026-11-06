import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Input,
  PanePrompt,
  PasswordInput,
} from "@termix-ssh/plugin-sdk/ui";

/** The errors the engine sends when RustDesk wants a password or code. */
const LOGIN_ERRORS = {
  "rustdesk-password-required": { kind: "password", wrong: false },
  "rustdesk-password-wrong": { kind: "password", wrong: true },
  "rustdesk-2fa-required": { kind: "code", wrong: false },
  "rustdesk-2fa-wrong": { kind: "code", wrong: true },
} as const;

export interface RustdeskPrompt {
  kind: "password" | "code";
  wrong: boolean;
}

export function rustdeskPromptFor(error: string): RustdeskPrompt | null {
  return LOGIN_ERRORS[error.trim() as keyof typeof LOGIN_ERRORS] ?? null;
}

/** Asks for the RustDesk password or 2FA code, for this session only. */
export function RustdeskLoginPrompt({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: RustdeskPrompt;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const code = prompt.kind === "code";
  const key = code ? "code" : "password";

  return (
    <div className="relative w-full h-full">
      <PanePrompt
        open
        title={t(`remoteDesktop.rustdesk.${key}Title`)}
        description={t(
          prompt.wrong
            ? `remoteDesktop.rustdesk.${key}Wrong`
            : `remoteDesktop.rustdesk.${key}Description`,
        )}
        onCancel={onCancel}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (value) onSubmit(value);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold">
              {t(code ? "remoteDesktop.rustdesk.code" : "hosts.guac.password")}
            </label>
            {code ? (
              <Input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            ) : (
              <PasswordInput
                autoFocus
                className="h-8 text-xs pr-8"
                placeholder="••••••••"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="outline" disabled={!value}>
              {t("remoteDesktop.connect")}
            </Button>
          </div>
        </form>
      </PanePrompt>
    </div>
  );
}
