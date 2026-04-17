import { useEffect, useState, useRef } from 'react';
import { Button } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import styles from './HelpRequests.module.css';
import { BACKEND_URL, WS_URL } from '../config';
import ParticipantLabel from './ParticipantLabel';

interface QueueItem {
  id: string;
  name: string;
  photo: string | null;
  helpType: string;        // "quick" | "a lot of"
  currentTask: string | null;
  taskConcepts: string[];
}

interface ProfileEntry {
  id: string;
  name: string;
  photo: string | null;
}

export default function HelpRequests() {
  const [storedUserId] = useLocalStorage({ key: 'participant-id', defaultValue: '?' });
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [accepting, setAccepting] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch help queue + profiles on mount and periodically
  const fetchData = async () => {
    try {
      const [qRes, pRes] = await Promise.all([
        fetch(`${BACKEND_URL}/helpQueue`),
        fetch(`${BACKEND_URL}/profiles`),
      ]);
      const qData = await qRes.json();
      const pData = await pRes.json();
      setQueue(qData.queue || []);
      setConnected(qData.connectedParticipants || []);
      if (pData.status === 'success' && pData.profiles) {
        const entries: ProfileEntry[] = Object.entries(pData.profiles).map(
          ([id, p]: [string, any]) => ({ id: id.replace(/"/g, ''), name: p.name, photo: p.photo })
        );
        setProfiles(entries);
      }
    } catch (e) {
      // backend not running
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // WebSocket for real-time updates
  useEffect(() => {
    if (storedUserId === '?') return;
    const ws = new WebSocket(`${WS_URL}/ws/${storedUserId}`);
    wsRef.current = ws;

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        // Re-fetch on help-related events
        if (['helpRequest', 'StartHelpSession', 'updateGraph'].includes(data.event)) {
          fetchData();
        }
      } catch {
        // ignore
      }
    };

    return () => { ws.close(); };
  }, [storedUserId]);

  // Accept help request (start session with the first person in queue)
  const acceptHelp = async (helpeeId: string) => {
    setAccepting(helpeeId);
    try {
      await fetch(`${BACKEND_URL}/StartHelpSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helper: storedUserId, time: 3, hint: '' }),
      });
      fetchData();
    } catch (e) {
      console.error('Failed to start help session:', e);
    } finally {
      setAccepting(null);
    }
  };

  const myId = storedUserId.replace(/"/g, '');
  const isInQueue = queue.some((q) => q.id === myId);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Help Requests</h1>
      <p className={styles.subtitle}>See who needs help and offer assistance to your teammates.</p>

      {/* Active help queue */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Waiting for Help
          <span className={`${styles.badge} ${queue.length > 0 ? styles.badgeRed : styles.badgeGray}`}>
            {queue.length}
          </span>
        </div>

        {queue.length === 0 ? (
          <div className={styles.emptyState}>
            No one is currently waiting for help. Check back later!
          </div>
        ) : (
          <div className={styles.cardList}>
            {queue.map((item) => {
              const isUrgent = item.helpType === 'a lot of';
              const isSelf = item.id === myId;
              return (
                <div
                  key={item.id}
                  className={`${styles.card} ${isUrgent ? styles.cardUrgent : styles.cardQuick}`}
                >
                  <div className={styles.cardBody}>
                    <div className={styles.cardName}>
                      <ParticipantLabel
                        id={item.id}
                        name={item.name}
                        photo={item.photo}
                        avatarSize={36}
                        textSize={16}
                      />
                      <span className={`${styles.helpTypeBadge} ${isUrgent ? styles.helpTypeStuck : styles.helpTypeQuick}`}>
                        {isUrgent ? 'Fully Stuck' : 'Quick Help'}
                      </span>
                    </div>

                    {item.currentTask && (
                      <div className={styles.cardMeta}>
                        Working on: <strong>{item.currentTask.replace(/_/g, ' ')}</strong>
                      </div>
                    )}

                    {item.taskConcepts.length > 0 && (
                      <div>
                        {item.taskConcepts.map((c) => (
                          <span key={c} className={styles.conceptTag}>{c}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className={styles.cardActions}>
                    {isSelf ? (
                      <Button size="compact-sm" variant="light" color="gray" disabled>
                        You
                      </Button>
                    ) : (
                      <Button
                        size="compact-sm"
                        color={isUrgent ? 'red' : 'orange'}
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
      </div>

      {/* All participants status */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Participants</div>
        <div className={styles.participantGrid}>
          {profiles.map((p) => {
            const isOnline = connected.includes(p.id);
            const inQueue = queue.find((q) => q.id === p.id);
            return (
              <div key={p.id} className={styles.participantCard}>
                <div style={{ margin: '0 auto 8px' }}>
                  <ParticipantLabel
                    id={p.id}
                    name={p.name}
                    photo={p.photo}
                    avatarSize={36}
                    textSize={16}
                  />
                </div>
                <div className={styles.statusLabel}>
                  <span className={`${styles.statusDot} ${isOnline ? styles.statusOnline : styles.statusOffline}`} />
                  {inQueue ? (
                    <span style={{ color: '#dc2626', fontWeight: 600 }}>Needs Help</span>
                  ) : isOnline ? 'Online' : 'Offline'}
                </div>
              </div>
            );
          })}
          {profiles.length === 0 && (
            <div className={styles.emptyState} style={{ gridColumn: '1 / -1' }}>
              No participants have joined yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
