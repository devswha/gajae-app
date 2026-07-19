import type { Dispatch, SetStateAction } from 'react';

export type SettingsMainTab = 'appearance' | 'git' | 'voice' | 'notifications' | 'about';
export type ProjectSortOrder = 'name' | 'date';


export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    // tmux 라이브(외부 구동) gjc 세션 턴 완료 — 웹 구동 stop과 별도 토글.
    liveStop: boolean;
    error: boolean;
  };
};


export type CodeEditorSettingsState = {
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};


export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
