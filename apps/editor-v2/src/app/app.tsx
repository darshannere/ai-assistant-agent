import { Route, Routes, Link, useLocation } from 'react-router-dom';
import { Title, AppShell, Text, Group, Burger, Avatar, Button, Drawer, Indicator } from '@mantine/core';
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
                  <Button
                    size="compact-sm"
                    variant={location.pathname === '/conceptdashboard' ? 'filled' : 'light'}
                    component={Link}
                    to="/conceptdashboard"
                  >
                    Concept Dashboard
                  </Button>
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
