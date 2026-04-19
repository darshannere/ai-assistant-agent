import { Route, Routes, Link, useLocation } from 'react-router-dom';
import { Title, AppShell, Text, Group, Burger, Avatar, Button, Drawer, Indicator, Menu, Stack } from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import { useState, useEffect, useCallback } from 'react';
import styles from './app.module.css';
import Home from "./components/Home"
import Editor from "./components/Editor"
import CollaborativeFlow from "./components/Tree2"
import HelpRequests from "./components/HelpRequests"
import HelpRequestsPanel from "./components/HelpRequestsPanel"
import ConceptDashboard from "./components/ConceptDashboard"
import { BACKEND_URL } from './config';
export function App() {
  const [opened, { toggle }] = useDisclosure();
  const location = useLocation();

  const [value, setValue] = useLocalStorage({
    key: 'participant-id',
    defaultValue: '?',
  });

  const [profile, setProfile] = useState<any>(null);
  const [helpDrawerOpen, setHelpDrawerOpen] = useState(false);
  const [helpQueueCount, setHelpQueueCount] = useState(0);
  const [availableHelpers, setAvailableHelpers] = useState<Array<{
    helperId?: string; helperName: string; helperPhoto?: string | null; concepts?: string[];
  }>>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setAvailableHelpers(detail?.helpers || []);
    };
    window.addEventListener('canary-helpers-updated', handler);
    return () => window.removeEventListener('canary-helpers-updated', handler);
  }, []);

  // Poll help queue count
  const fetchQueueCount = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/helpQueue`);
      const data = await res.json();
      setHelpQueueCount((data.queue || []).length);
    } catch { /* backend down */ }
  }, []);

  useEffect(() => {
    fetchQueueCount();
    const interval = setInterval(fetchQueueCount, 5000);
    return () => clearInterval(interval);
  }, [fetchQueueCount]);

  useEffect(() => {
    const fetchProfile = async () => {
      if (value && value !== '?') {
        console.log('Fetching profile for:', value);
        try {
          const response = await fetch(`${BACKEND_URL}/profile/${value}`);
          const data = await response.json();
          console.log('Profile fetch response:', data);
          if (data.status === 'success' && data.profile) {
            console.log('Profile found:', { name: data.profile.name, hasPhoto: !!data.profile.photo });
            setProfile(data.profile);
          } else {
            console.log('No profile found for', value);
            setProfile(null);
          }
        } catch (error) {
          console.error('Failed to fetch profile:', error);
        }
      }
    };
    fetchProfile();
  }, [value, location.pathname]);

  // Only show profile on editor/draw pages, not on home
  const showProfile = location.pathname !== '/';

  return (
    <div>
      <AppShell
        header={{ height: 60 }}
        navbar={{ width: 300, breakpoint: 'sm', collapsed: { desktop: true, mobile: !opened } }}
        padding="md"
      >
        <AppShell.Header>
          <Group h="100%" px="md">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Group justify="space-between" style={{ flex: 1 }}>
              <div className={styles.brandTitleWrap}>
                <span className={styles.brandIcon} aria-hidden="true">&#x1F424;</span>
                <Title order={2} className={styles.brandTitle}>Canary</Title>
              </div>
              {showProfile && (
                <Group ml="xl" gap={10} visibleFrom="sm">
                  <Indicator label={helpQueueCount} size={18} color="red" disabled={helpQueueCount === 0} offset={4}>
                    <Button size="compact-sm" variant="light" color="red" onClick={() => setHelpDrawerOpen(true)}>
                      Help Requests
                    </Button>
                  </Indicator>
                  {availableHelpers.length > 0 && (
                    <Menu shadow="md" width={280} position="bottom-end">
                      <Menu.Target>
                        <Indicator label={availableHelpers.length} size={18} color="teal" offset={4}>
                          <Button size="compact-sm" variant="light" color="teal">
                            Available Helpers
                          </Button>
                        </Indicator>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>Who can help you right now</Menu.Label>
                        {availableHelpers.map((h, idx) => (
                          <Menu.Item key={`${h.helperId || h.helperName}-${idx}`}>
                            <Group gap={8} wrap="nowrap">
                              {h.helperPhoto ? (
                                <img
                                  src={h.helperPhoto}
                                  alt={h.helperName}
                                  style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }}
                                />
                              ) : (
                                <Avatar size={24} radius="xl">{h.helperName?.[0]?.toUpperCase() || '?'}</Avatar>
                              )}
                              <Stack gap={0}>
                                <Text size="sm" fw={600}>{h.helperName}</Text>
                                <Text size="xs" c="dimmed">
                                  can help with {(h.concepts && h.concepts[0]) || 'this task'}
                                </Text>
                              </Stack>
                            </Group>
                          </Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                  {profile && profile.photo ? (
                    <Group gap={8}>
                      <img
                        src={profile.photo}
                        alt={profile.name}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          objectFit: 'cover',
                          border: '2px solid #ddd'
                        }}
                      />
                      <Text size='md' fw={500}>{profile.name} ({value})</Text>
                    </Group>
                  ) : (
                    <Text size='md'>Participant {value}</Text>
                  )}
                </Group>
              )}
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Main>
          <Routes>
            <Route
              path="/"
              element={ <Home setValue={setValue}/> }
            />
            <Route
              path="/editor"
              element={ <Editor/> }
            />
            <Route
              path="/help"
              element={ <HelpRequests/> }
            />
            <Route
              path="/draw"
              element={ <CollaborativeFlow id={value}/> }
            />
            <Route
              path="/conceptdashboard"
              element={ <ConceptDashboard /> }
            />
          </Routes>
        </AppShell.Main>
      </AppShell>
      <Drawer
        opened={helpDrawerOpen}
        onClose={() => setHelpDrawerOpen(false)}
        title="Help Requests"
        position="right"
        size="md"
        overlayProps={{ backgroundOpacity: 0.15 }}
      >
        <HelpRequestsPanel onQueueUpdate={setHelpQueueCount} />
      </Drawer>
    </div>
  );
}

export default App;
