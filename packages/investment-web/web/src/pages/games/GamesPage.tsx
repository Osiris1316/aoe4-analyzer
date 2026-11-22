// Games: every analysed player-game, or the pinned player's with a switch to everyone.
import { GameList } from '../../features/games/GameList';
import { setEveryone, usePin } from '../../lib/pin';
import { PinIcon } from '../../kit/Pin';
import s from './GamesPage.module.css';

export function GamesPage() {
  const { pin, everyone } = usePin();
  const only = pin && !everyone ? pin.ids : null;
  const intro = (
    <p className={s.intro}>
      What each player spent on military in an age, counted in age-ups: 1.0x is the cost of their next age-up.
      Production buildings, units and defenses count. Walls are listed on their own.
    </p>
  );
  const who = pin ? (
    <div className={s.who} role="group" aria-label="Whose games">
      <button type="button" aria-pressed={!everyone} onClick={() => setEveryone(false)}>
        <PinIcon filled /><span className={s.whoName}>{pin.person}</span>
      </button>
      <button type="button" aria-pressed={everyone} onClick={() => setEveryone(true)}>Everyone</button>
    </div>
  ) : null;
  return (
    <main className="frame">
      <GameList players={only} top={who} intro={intro} />
    </main>
  );
}
