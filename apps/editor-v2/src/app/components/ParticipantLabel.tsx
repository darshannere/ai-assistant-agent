type ParticipantLabelProps = {
  id: string;
  name?: string | null;
  photo?: string | null;
  suffix?: string;
  avatarSize?: number;
  textSize?: number;
  weight?: number;
};

export default function ParticipantLabel({
  id,
  name,
  photo,
  suffix = "",
  avatarSize = 20,
  textSize = 14,
  weight = 600,
}: ParticipantLabelProps) {
  const displayName = name?.trim() || id;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {photo ? (
        <img
          src={photo}
          alt={displayName}
          style={{
            width: avatarSize,
            height: avatarSize,
            borderRadius: '50%',
            objectFit: 'cover',
            flexShrink: 0,
          }}
        />
      ) : (
        <span
          style={{
            width: avatarSize,
            height: avatarSize,
            borderRadius: '50%',
            background: '#334155',
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.max(10, Math.round(avatarSize * 0.5)),
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {initial}
        </span>
      )}
      <span style={{ fontSize: textSize, fontWeight: weight, lineHeight: 1.2 }}>
        {displayName}
        {suffix}
      </span>
    </span>
  );
}
