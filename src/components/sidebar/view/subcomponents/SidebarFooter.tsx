import { Settings, Bug } from 'lucide-react';
import type { TFunction } from 'i18next';


const GITHUB_ISSUES_URL = 'https://github.com/devswha/gajae-app/issues/new';
const GITHUB_REPO_URL = 'https://github.com/devswha/gajae-app';

const DISCORD_INVITE_URL = 'https://discord.gg/dskZax5JPh';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

type SidebarFooterProps = {
  currentVersion: string;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  currentVersion,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>

      {/* Community + Settings */}
      <div className="nav-divider" />

      {/* Desktop Report Issue */}
      <div className="hidden px-2 pt-1.5 md:block">
        <a
          href={GITHUB_ISSUES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Bug className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.reportIssue')}</span>
        </a>
      </div>

      {/* Desktop Discord */}
      <div className="hidden px-2 md:block">
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <DiscordIcon className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.joinCommunity')}</span>
        </a>
      </div>

      {/* Desktop settings */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Desktop version brand line */}
      <div className="hidden px-3 py-2 text-center md:block">
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        >
          Gajae App v{currentVersion} – {t('branding.openSource')}
        </a>
      </div>

      {/* Mobile Report Issue */}
      <div className="px-3 pt-3 md:hidden">
        <a
          href={GITHUB_ISSUES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Bug className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.reportIssue')}</span>
        </a>
      </div>

      {/* Mobile Discord */}
      <div className="px-3 pt-2 md:hidden">
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <DiscordIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.joinCommunity')}</span>
        </a>
      </div>

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-2 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
        </button>
      </div>
    </div>
  );
}
