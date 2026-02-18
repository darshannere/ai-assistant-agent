import { Route, Routes, Link, useLocation } from 'react-router-dom';
import { Title, AppShell, Text, Group, Burger, Avatar } from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import { useState, useEffect } from 'react';
import Home from "./components/Home"
import Editor from "./components/Editor"
import CollaborativeFlow from "./components/Tree2"
export function App() {
  const [opened, { toggle }] = useDisclosure();
  const location = useLocation();

  const [value, setValue] = useLocalStorage({
    key: 'participant-id',
    defaultValue: '?',
  });

  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    const fetchProfile = async () => {
      if (value && value !== '?') {
        console.log('Fetching profile for:', value);
        try {
          const response = await fetch(`http://localhost:8000/profile/${value}`);
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
              <Title order={2}>Canary</Title>
              {showProfile && (
                <Group ml="xl" gap={10} visibleFrom="sm">
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
              path="/draw"
              element={ <CollaborativeFlow id={value}/> }
            />
          </Routes>
        </AppShell.Main>
      </AppShell>
    </div>
  );
}

export default App;
