import { useEffect, useState, useCallback } from 'react';
import { Button } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import styles from './HelpRequests.module.css';
import { BACKEND_URL } from '../config';

interface QueueItem {
  id: string;
  name: string;
  photo: string | null;
  helpType: string;
  currentTask: string | null;
  taskConcepts: string[];
}

interface ActiveSession {
  helperId: string;
  helperName: string;
  helperPhoto: string | null;
  helpeeId: string;
  helpeeName: string;
  helpeePhoto: string | null;
  duration: number;
  startedAt: number;
}

interface ProfileEntry {
  id: string;
  name: string;
  photo: string | null;
}

interface ParticipantState {
  status: string;
  currentTasks: string[];
  name: string;
  photo: string | null;
  concepts: string[];
}

// URL from config

interface Props {
  onQueueUpdate?: (count: number) => void;
}

export default function HelpRequestsPanel({ onQueueUpdate }: Props) {
  const [storedUserId] = useLocalStorage({ key: 'participant-id', defaultValue: '?' });
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [myConcepts, setMyConcepts] = useState<string[]>([]);
  const [participantStates, setParticipantStates] = useState<Record<string, ParticipantState>>({});

  const fetchData = useCallback(async () => {
    try {
      const [qRes, pRes, sRes] = await Promise.all([
        fetch(`${BACKEND_URL}/helpQueue`),
        fetch(`${BACKEND_URL}/profiles`),
        fetch(`${BACKEND_URL}/debug/states`),
      ]);
      const qData = await qRes.json();
      const pData = await pRes.json();
      const sData = await sRes.json();
      const q = qData.queue || [];
      setQueue(q);
      setActiveSessions(qData.activeSessions || []);
      setConnected(qData.connectedParticipants || []);
      onQueueUpdate?.(q.length);

      if (pData.status === 'success' && pData.profiles) {
        const entries: ProfileEntry[] = Object.entries(pData.profiles).map(
          ([id, p]: [string, any]) => ({ id: id.replace(/"/g, ''), name: p.name, photo: p.photo })
        );
        setProfiles(entries);
      }

      const myId = storedUserId.replace(/"/g, '');
      const accumulated = sData.accumulatedConcepts || {};
      setMyConcepts(accumulated[myId] || []);
      setParticipantStates(sData.participantStates || {});
    } catch { /* backend down */ }
  }, [onQueueUpdate, storedUserId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const acceptHelp = async (helpeeId: string) => {
    setAccepting(helpeeId);
    try {
      await fetch(`${BACKEND_URL}/StartHelpSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helper: storedUserId, helpeeId, time: 3, hint: '' }),
      });
      fetchData();
    } catch (e) {
      console.error('Failed to start help session:', e);
    } finally {
      setAccepting(null);
    }
  };

  const myId = storedUserId.replace(/"/g, '');

  const getMatchingConcepts = (taskConcepts: string[]) => {
    return taskConcepts.filter(c => myConcepts.includes(c));
  };

  // Sessions involving me
  const myActiveSessions = activeSessions.filter(s => s.helperId === myId || s.helpeeId === myId);

  // Time remaining for a session
  const getTimeRemaining = (session: ActiveSession) => {
    const elapsed = Math.floor(Date.now() / 1000) - session.startedAt;
    const remaining = session.duration - elapsed;
    if (remaining <= 0) return 'Ending soon';
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return `${m}:${s.toString().padStart(2, '0')} remaining`;
  };

  return (
    <div>
      {/* Active Help Sessions */}
      {activeSessions.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className={styles.sectionTitle}>
            Active Help Sessions
            <span className={`${styles.badge}`} style={{ background: '#22c55e' }}>
              {activeSessions.length}
            </span>
          </div>
          <div className={styles.cardList}>
            {activeSessions.map((session, i) => {
              const isMySession = session.helperId === myId || session.helpeeId === myId;
              const iAmHelper = session.helperId === myId;
              const iAmHelpee = session.helpeeId === myId;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px', borderRadius: 10,
                  background: isMySession ? '#f0fdf4' : '#fff',
                  border: `1px solid ${isMySession ? '#86efac' : '#e5e7eb'}`,
                  animation: 'cardSlideIn 280ms ease-out',
                }}>
                  {/* Helper avatar */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    {session.helperPhoto ? (
                      <img src={session.helperPhoto} alt={session.helperName}
                        style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid #22c55e' }} />
                    ) : (
                      <div style={{
                        width: 36, height: 36, borderRadius: '50%', background: '#dcfce7',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, fontWeight: 700, color: '#166534', border: '2px solid #22c55e',
                      }}>{session.helperName.charAt(0)}</div>
                    )}
                    <span style={{ fontSize: 9, color: '#6b7280' }}>Helper</span>
                  </div>

                  {/* Arrow */}
                  <span style={{ fontSize: 18, color: '#22c55e' }}>→</span>

                  {/* Helpee avatar */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    {session.helpeePhoto ? (
                      <img src={session.helpeePhoto} alt={session.helpeeName}
                        style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid #f59e0b' }} />
                    ) : (
                      <div style={{
                        width: 36, height: 36, borderRadius: '50%', background: '#fef3c7',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, fontWeight: 700, color: '#92400e', border: '2px solid #f59e0b',
                      }}>{session.helpeeName.charAt(0)}</div>
                    )}
                    <span style={{ fontSize: 9, color: '#6b7280' }}>Helpee</span>
                  </div>

                  {/* Details */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {session.helperName} helping {session.helpeeName}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      {getTimeRemaining(session)}
                    </div>
                    {isMySession && (
                      <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600, marginTop: 2 }}>
                        {iAmHelper ? "You're helping" : "You're being helped"}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Your Expertise */}
      {myConcepts.length > 0 && (
        <div style={{ marginBottom: 20, padding: '12px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>
            You Can Help With
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {myConcepts.map(c => (
              <span key={c} style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                background: '#dcfce7', color: '#166534', fontSize: 11, fontWeight: 600,
              }}>{c}</span>
            ))}
          </div>
        </div>
      )}

      {/* Waiting for Help */}
      <div className={styles.sectionTitle}>
        Waiting for Help
        <span className={`${styles.badge} ${queue.length > 0 ? styles.badgeRed : styles.badgeGray}`}>
          {queue.length}
        </span>
      </div>

      {queue.length === 0 ? (
        <div className={styles.emptyState}>
          No one is waiting for help right now.
        </div>
      ) : (
        <div className={styles.cardList}>
          {queue.map((item) => {
            const isUrgent = item.helpType === 'a lot of';
            const isSelf = item.id === myId;
            const matching = getMatchingConcepts(item.taskConcepts);
            return (
              <div key={item.id} className={`${styles.card} ${isUrgent ? styles.cardUrgent : styles.cardQuick}`}>
                {item.photo ? (
                  <img src={item.photo} alt={item.name} className={styles.avatar} />
                ) : (
                  <div className={styles.avatarPlaceholder}>
                    {item.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className={styles.cardBody}>
                  <div className={styles.cardName}>
                    {item.name} ({item.id})
                    <span className={`${styles.helpTypeBadge} ${isUrgent ? styles.helpTypeStuck : styles.helpTypeQuick}`}>
                      {isUrgent ? 'Fully Stuck' : 'Quick Help'}
                    </span>
                  </div>
                  {isSelf && (
                    <div style={{ fontSize: 12, color: '#d97706', fontWeight: 600, marginTop: 2 }}>
                      Active help request — waiting for someone to accept
                    </div>
                  )}
                  {item.currentTask && (
                    <div className={styles.cardMeta}>
                      Working on: <strong>{item.currentTask.replace(/_/g, ' ')}</strong>
                    </div>
                  )}
                  {item.taskConcepts.length > 0 && (
                    <div>
                      {item.taskConcepts.map((c) => (
                        <span key={c} className={styles.conceptTag} style={
                          matching.includes(c) ? { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' } : {}
                        }>{c}{matching.includes(c) ? ' ✓' : ''}</span>
                      ))}
                    </div>
                  )}
                  {matching.length > 0 && !isSelf && (
                    <div style={{ fontSize: 12, color: '#15803d', fontWeight: 600, marginTop: 4 }}>
                      You know {matching.length} of their concepts — you can help!
                    </div>
                  )}
                </div>
                <div className={styles.cardActions}>
                  {isSelf ? (
                    <Button size="compact-sm" variant="light" color="yellow" disabled>Pending</Button>
                  ) : (
                    <Button
                      size="compact-sm"
                      color={matching.length > 0 ? 'green' : isUrgent ? 'red' : 'orange'}
                      loading={accepting === item.id}
                      onClick={() => acceptHelp(item.id)}
                    >
                      Help {item.name}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Participants */}
      <div style={{ marginTop: 24 }}>
        <div className={styles.sectionTitle}>Participants</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {profiles.map((p) => {
            const isOnline = connected.includes(p.id);
            const inQueue = queue.find((q) => q.id === p.id);
            const state = participantStates[p.id];
            const isMe = p.id === myId;
            const helping = activeSessions.find(s => s.helperId === p.id);
            const beingHelped = activeSessions.find(s => s.helpeeId === p.id);
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: isMe ? '#f0fdf4' : '#fff',
                border: `1px solid ${isMe ? '#bbf7d0' : '#e5e7eb'}`,
                borderRadius: 8,
              }}>
                {p.photo ? (
                  <img src={p.photo} alt={p.name} className={styles.avatar} style={{ width: 32, height: 32 }} />
                ) : (
                  <div className={styles.avatarPlaceholder} style={{ width: 32, height: 32, fontSize: 14 }}>
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {p.name} ({p.id}){isMe ? ' (you)' : ''}
                  </div>
                  {state?.currentTasks && state.currentTasks.length > 0 && (
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      Working on: {state.currentTasks.map(t => t.replace(/_/g, ' ')).join(', ')}
                    </div>
                  )}
                  {helping && (
                    <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600 }}>
                      Helping {helping.helpeeName}
                    </div>
                  )}
                  {beingHelped && (
                    <div style={{ fontSize: 11, color: '#d97706', fontWeight: 600 }}>
                      Being helped by {beingHelped.helperName}
                    </div>
                  )}
                </div>
                <div className={styles.statusLabel}>
                  <span className={`${styles.statusDot} ${isOnline ? styles.statusOnline : styles.statusOffline}`} />
                  {inQueue ? (
                    <span style={{ color: '#dc2626', fontWeight: 600 }}>Needs Help</span>
                  ) : helping ? (
                    <span style={{ color: '#15803d', fontWeight: 600 }}>Helping</span>
                  ) : beingHelped ? (
                    <span style={{ color: '#d97706', fontWeight: 600 }}>In Session</span>
                  ) : state?.status === 'unavailable' ? (
                    <span style={{ color: '#d97706', fontWeight: 600 }}>Busy</span>
                  ) : isOnline ? 'Online' : 'Offline'}
                </div>
              </div>
            );
          })}
          {profiles.length === 0 && (
            <div className={styles.emptyState}>No participants yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
