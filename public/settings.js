import {
  $,
  api,
  ready,
  busy,
  message,
  settings,
  readLocal,
  writeLocal,
  element,
  button,
  coordsText,
} from './common.js';
await ready;
const config = settings();
$('units').value = config.units;
$('default-preference').value = config.preference;
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  try {
    writeLocal('photopath-settings', {
      units: $('units').value,
      preference: Number($('default-preference').value),
    });
    message('Preferences saved in this browser.');
  } catch (error) {
    message(error.message, true);
  }
});
function renderFavorites() {
  const all = readLocal('photopath-favorites', []);
  $('favorites').replaceChildren();
  if (!all.length)
    $('favorites').append(
      element('p', 'Save a destination from the map to find it here.', 'empty'),
    );
  all.forEach((p, index) => {
    const item = element('div', null, 'activity-item'),
      link = element('a', p.name);
    link.href = `/map?${new URLSearchParams({ lat: p.latitude, lon: p.longitude, destination: '1', name: p.name })}`;
    const remove = button(
      'Remove',
      () => {
        try {
          writeLocal(
            'photopath-favorites',
            all.filter((_, i) => i !== index),
          );
          renderFavorites();
        } catch (e) {
          message(e.message, true);
        }
      },
      'text-button danger',
    );
    item.append(link, remove);
    $('favorites').append(item);
  });
}
async function renderContributions() {
  const data = await api('/api/contributions');
  $('contributions').replaceChildren();
  if (!data.items.length)
    $('contributions').append(
      element(
        'p',
        'Nothing shared yet. Take a nighttime reading or report a light to help your neighborhood.',
        'empty',
      ),
    );
  data.items.forEach((record) => {
    const item = element('article', null, 'activity-item');
    item.append(
      element(
        'h3',
        record.kind === 'reports'
          ? `${record.report_type} light · ${record.status.replaceAll('_', ' ')}`
          : `Visibility ${record.score}/100 · ${record.is_night ? 'Nighttime' : 'Daytime'}`,
      ),
      element('p', `${coordsText(record)} · ${new Date(record.timestamp).toLocaleString()}`),
    );
    if (record.description) item.append(element('p', record.description));
    const actions = element('div', null, 'activity-actions'),
      link = element('a', 'View on map');
    link.href = `/map?lat=${record.latitude}&lon=${record.longitude}`;
    const remove = button(
      'Delete',
      () => {
        if (!confirm('Delete this contribution from the community map? This cannot be undone.'))
          return;
        busy(remove, async () => {
          await api(`/api/${record.kind}/${record.id}`, null, 'DELETE');
          await renderContributions();
          message('Contribution deleted.');
        });
      },
      'text-button danger',
    );
    actions.append(link, remove);
    item.append(actions);
    $('contributions').append(item);
  });
}
renderFavorites();
renderContributions().catch((e) => {
  $('contributions').replaceChildren(
    element('p', 'Could not load your activity.', 'empty'),
    button('Try again', () => renderContributions().catch((error) => message(error.message, true))),
  );
  message(e.message, true);
});
