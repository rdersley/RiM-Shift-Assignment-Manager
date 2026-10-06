import React, { useState } from 'react';
import ForgeReconciler, { Badge, Box, Heading, Inline, Lozenge, Stack, Text } from '@forge/react';
import RosterView from './RosterView.jsx';

const cardXcss = { borderWidth: 'border.width', borderStyle: 'solid', borderColor: 'color.border', borderRadius: 'border.radius', padding: 'space.200' };

// Read-only Shift Schedule for every Jira user. Data comes from getPublicSchedule, which never writes.
function App() {
  const [data, setData] = useState(null);

  return <Stack space="space.300">
    <Stack space="space.050"><Heading size="large">Shift Schedule</Heading><Text>See who is working now, the rota, and service-desk coverage.</Text></Stack>

    <Box xcss={cardXcss}><Stack space="space.100">
      <Inline spread="space-between" alignBlock="center"><Heading size="small">On shift now</Heading><Text>{`${data?.onShiftCount || 0} agent(s)`}</Text></Inline>
      {(data?.onShift || []).map(group => <Inline key={group.id} space="space.100" alignBlock="center" shouldWrap>
        <Text as="strong">{group.name}:</Text>
        {group.onShift.length ? group.onShift.map(user => <Badge key={user.accountId}>{user.displayName}</Badge>) : <Lozenge appearance="moved">Nobody</Lozenge>}
      </Inline>)}
    </Stack></Box>

    <RosterView resolverName="getPublicSchedule" onLoaded={setData} />
  </Stack>;
}

ForgeReconciler.render(<App />);
