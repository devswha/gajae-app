import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`, and
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

import type {
  JobProjectionErrorCode,
  JobProjectionEvent,
  JobSnapshot,
} from '../../shared/gjc-job-projection-protocol';

type JobSubscription = {
  jobId: string;
  getCursor: () => number;
  onSubscribed: (snapshot: JobSnapshot) => void;
  applyReplayChunk: (events: JobProjectionEvent[]) => boolean;
  applyLiveEvent: (event: JobProjectionEvent) => boolean;
  onError: (code: JobProjectionErrorCode) => void;
};

type JobSubscriptionIntent = JobSubscription & { owners: number; subscriptionId: number; generation: number };
type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  subscribe: (listener: ServerEventListener) => () => void;
  registerJobSubscription: (subscription: JobSubscription) => () => void;
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) throw new Error('useWebSocket must be used within a WebSocketProvider');
  return context;
};

const buildWebSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const listenersRef = useRef(new Set<ServerEventListener>());
  const jobIntentsRef = useRef(new Map<string, JobSubscriptionIntent>());
  const nextJobSubscriptionIdRef = useRef(0);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { user } = useAuth();
  const authenticatedUserRef = useRef(user);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  const clearReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const sendJobFrame = useCallback((frame: unknown) => {
    const activeSocket = wsRef.current;
    if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify(frame));
  }, []);

  const subscribeJobsForGeneration = useCallback((generation: number) => {
    for (const intent of jobIntentsRef.current.values()) {
      intent.generation = generation;
      intent.subscriptionId = ++nextJobSubscriptionIdRef.current;
      sendJobFrame({
        protocolVersion: 1,
        kind: 'gjc.job.subscribe',
        jobId: intent.jobId,
        after: intent.getCursor(),
        subscriptionId: intent.subscriptionId,
      });
    }
  }, [sendJobFrame]);

  const connect = useCallback((generation: number, isAuthenticated: boolean) => {
    if (unmountedRef.current || socketGenerationRef.current !== generation || !isAuthenticated) return;
    const wsUrl = buildWebSocketUrl();

    try {
      const websocket = new WebSocket(wsUrl);
      // Claim ownership before any asynchronous browser callback can fire.
      wsRef.current = websocket;
      setSocket(websocket);

      const isCurrentSocket = () =>
        !unmountedRef.current && socketGenerationRef.current === generation && wsRef.current === websocket;

      websocket.onopen = () => {
        if (!isCurrentSocket()) return;
        setIsConnected(true);
        if (hasConnectedRef.current) dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        hasConnectedRef.current = true;
        subscribeJobsForGeneration(generation);
      };

      websocket.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        try {
          const message = JSON.parse(event.data) as ServerEvent & { jobId?: string; subscriptionId?: number; event?: JobProjectionEvent; events?: JobProjectionEvent[]; snapshot?: JobSnapshot; code?: JobProjectionErrorCode };
          const intent = typeof message.jobId === 'string' ? jobIntentsRef.current.get(message.jobId) : undefined;
          const isCurrentJobFrame = intent
            && intent.generation === generation
            && message.subscriptionId === intent.subscriptionId;
          if (isCurrentJobFrame && message.kind === 'gjc_job_subscribed' && message.snapshot) {
            intent.onSubscribed(message.snapshot);
          } else if (isCurrentJobFrame && message.kind === 'gjc_job_replay_chunk' && Array.isArray(message.events)) {
            const applied = intent.applyReplayChunk(message.events);
            if (applied) {
              sendJobFrame({ protocolVersion: 1, kind: 'gjc.job.replay', jobId: intent.jobId, after: intent.getCursor(), subscriptionId: intent.subscriptionId });
            }
          } else if (isCurrentJobFrame && message.kind === 'gjc_job_event' && message.event) {
            intent.applyLiveEvent(message.event);
          } else if (isCurrentJobFrame && message.kind === 'gjc_job_error' && message.code) {
            intent.onError(message.code);
          }
          dispatch(message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (!isCurrentSocket()) return;
        setIsConnected(false);
        wsRef.current = null;
        setSocket(null);
        clearReconnect();
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (unmountedRef.current || socketGenerationRef.current !== generation) return;
          connect(generation, isAuthenticated);
        }, 3000);
      };

      websocket.onerror = (event) => {
        if (isCurrentSocket()) console.error('WebSocket error:', event);
      };
    } catch (error) {
      if (socketGenerationRef.current === generation && !unmountedRef.current) {
        console.error('Error creating WebSocket connection:', error);
      }
    }
  }, [clearReconnect, dispatch, subscribeJobsForGeneration]);

  useEffect(() => {
    if (authenticatedUserRef.current !== user) {
      jobIntentsRef.current.clear();
      authenticatedUserRef.current = user;
    }
  }, [user]);
  useEffect(() => {
    unmountedRef.current = false;
    const generation = socketGenerationRef.current + 1;
    socketGenerationRef.current = generation;
    clearReconnect();

    const previousSocket = wsRef.current;
    wsRef.current = null;
    setSocket(null);
    setIsConnected(false);
    previousSocket?.close();
    connect(generation, Boolean(user));

    return () => {
      if (socketGenerationRef.current !== generation) return;
      socketGenerationRef.current += 1;
      clearReconnect();
      const activeSocket = wsRef.current;
      wsRef.current = null;
      setSocket(null);
      setIsConnected(false);
      activeSocket?.close();
    };
  }, [clearReconnect, connect, user]);

  useEffect(() => () => {
    unmountedRef.current = true;
  }, []);

  const sendMessage = useCallback((message: unknown) => {
    const activeSocket = wsRef.current;
    if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify(message));
    else console.warn('WebSocket not connected');
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);
  const registerJobSubscription = useCallback((subscription: JobSubscription) => {
    const existing = jobIntentsRef.current.get(subscription.jobId);
    if (existing) {
      existing.owners += 1;
      Object.assign(existing, subscription);
    } else {
      jobIntentsRef.current.set(subscription.jobId, {
        ...subscription,
        owners: 1,
        subscriptionId: 0,
        generation: socketGenerationRef.current,
      });
    }
    const intent = jobIntentsRef.current.get(subscription.jobId)!;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      intent.subscriptionId = ++nextJobSubscriptionIdRef.current;
      sendJobFrame({ protocolVersion: 1, kind: 'gjc.job.subscribe', jobId: intent.jobId, after: intent.getCursor(), subscriptionId: intent.subscriptionId });
    }
    return () => {
      const current = jobIntentsRef.current.get(subscription.jobId);
      if (!current) return;
      current.owners -= 1;
      if (current.owners === 0) {
        sendJobFrame({ protocolVersion: 1, kind: 'gjc.job.unsubscribe', jobId: current.jobId, subscriptionId: current.subscriptionId });
        jobIntentsRef.current.delete(subscription.jobId);
      }
    };
  }, [sendJobFrame]);

  return useMemo(() => ({
    ws: socket,
    sendMessage,
    subscribe,
    registerJobSubscription,
    latestMessage,
    isConnected,
  }), [isConnected, latestMessage, registerJobSubscription, sendMessage, socket, subscribe]);
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  return <WebSocketContext.Provider value={webSocketData}>{children}</WebSocketContext.Provider>;
};

export default WebSocketContext;
