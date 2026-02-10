import { Route, Routes, Link } from 'react-router-dom';
import { Title, AppShell, Text, Group, Burger } from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import Home from "./components/Home"
import Editor from "./components/Editor"
import CollaborativeFlow from "./components/Tree2"
export function App() {
  const [opened, { toggle }] = useDisclosure();

  const [value, setValue] = useLocalStorage({
    key: 'participant-id',
    defaultValue: '?',
  });

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
              <Group ml="xl" gap={10} visibleFrom="sm">
                <Text size='md'>Participant {value}</Text>
              </Group>
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
