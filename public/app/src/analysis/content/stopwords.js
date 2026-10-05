// Stopwords: a full English list plus a minimal list of the most frequent
// function words in Spanish, French, German, Portuguese, Italian and Dutch, so
// mixed-language workspaces do not produce "de", "la", "und" as keywords.
// Chat filler ("ok", "lol", "yeah") is included because it dominates short
// messages without saying anything about topic.

const EN = `a about above after again against all almost also am among an and any are aren't as at be because been before
being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
either else ever every few for from further get gets got had hadn't has hasn't have haven't having he he'd he'll he's her
here here's hers herself him himself his how how's however i i'd i'll i'm i've if in into is isn't it it's its itself
just let's like may me might more most must mustn't my myself neither no nor not now of off often on once one only or
other ought our ours ourselves out over own per quite rather really same say says shall shan't she she'd she'll she's
should shouldn't since so some still such than that that's the their theirs them themselves then there there's these
they they'd they'll they're they've this those though through thus to too under until up upon us very was wasn't we
we'd we'll we're we've were weren't what what's when when's where where's whether which while who who's whom whose why
why's will with within without won't would wouldn't yet you you'd you'll you're you've your yours yourself yourselves
im ive id dont doesnt didnt cant wont isnt arent wasnt werent youre theyre thats whats lets
ok okay yeah yes yep nope lol haha hahaha hi hey hello thanks thank thx pls please sure oh ah um uh hmm also get got
will would could going gonna wanna want know think see one two three new now well good great much many lot lots`;
const ES = 'de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros es son está están fue ser hola gracias';
const FR = "le la les de des du un une et en à au aux ce ces cet cette il elle ils elles je tu nous vous on ne pas plus par pour sur dans avec sans sous qui que quoi dont où est sont été être avoir a ont fait mais ou donc car ni se sa son ses leur leurs mon ma mes ton ta tes notre nos votre vos y c'est j'ai bonjour merci oui non";
const DE = 'der die das den dem des ein eine einer eines einem einen und oder aber nicht ist sind war waren sein haben hat hatte ich du er sie es wir ihr mit von zu zum zur im in an auf aus bei für über unter nach vor durch bis auch noch nur schon so wie was wenn dass ob als um man mich mir dich dir sich uns euch hallo danke ja nein';
const PT = 'de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos elas havia seja qual será nós tenho lhe deles essas esses pelas este fosse dele tu te vocês vos lhes meus minhas teu tua teus tuas nosso nossa nossos nossas dela delas esta estes estas aquele aquela aqueles aquelas isto aquilo obrigado obrigada olá sim';
const IT = 'il lo la i gli le di a da in con su per tra fra un uno una e ed o ma se che chi cui non più come anche io tu lui lei noi voi loro mi ti ci vi si del della dei delle al alla ai alle nel nella è sono era essere ho ha hanno questo questa quello quella ciao grazie sì';
const NL = 'de het een en van in is dat op te zijn voor met die niet aan er maar om ook als bij of dan nog wel naar uit tot je ik we ze hij zij u dit wat hoe wie waar door over heb heeft had hebben was waren hallo dank ja nee';

// Dates and mail furniture. Quoted-reply headers ("On Tue, 4 Feb 2025 at
// 10:12, Ann wrote:") survive in mail that the reply stripper cannot parse,
// and their words then dominate topics.
const CAL = `mon tue tues wed thu thur thurs fri sat sun monday tuesday wednesday thursday friday saturday sunday
jan feb mar apr jun jul aug sep sept oct nov dec january february march april june july august september october november december
am pm utc gmt wrote fwd fw re cc bcc`;

export const STOPWORDS = new Set([EN, ES, FR, DE, PT, IT, NL, CAL].join(' ').split(/\s+/).filter(Boolean));

// Top-level and generic mail domain labels: never a person's name and never
// a topic, but present in every address that slips through.
export const DOMAIN_NOISE = new Set(['com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'uk', 'us', 'de', 'fr', 'example', 'mail', 'gmail', 'googlemail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'me', 'live', 'msn', 'aol', 'proton', 'protonmail', 'www']);

// Everyday English vocabulary beyond the stopwords: common verbs (with their
// irregular forms), nouns, adjectives and adverbs. Not removed from keywords
// or topics (there they can carry meaning); used where only new vocabulary
// should count, as when diffusion picks words automatically ("started",
// "using" and "ask" are not new words even when a dataset first shows them
// late). isCommonWord also strips regular endings (-s, -es, -ed, -ing, -er,
// -est, -ly), so "asked", "tries" and "running" match their base form.
const COMMON = `ask add agree allow answer appear apply arrive attend avoid back bake become begin believe belong blow book
break bring build burn buy call came can care carry catch cause change check choose clean clear close come consider
continue cook cost count cover create cut deal decide deliver describe design develop die discuss do draw dream dress
drink drive drop eat end enjoy enter explain fail fall feel fight fill find finish fit fix fly follow forget forgive
form give go grow handle hang happen hate head hear help hide hit hold hope hurt improve include increase join jump
keep kill kick know laugh lay lead learn leave lend lie lift light listen live look lose love make manage mark matter
mean meet mention mind miss move need note notice offer open order own pass pay pick plan play point prefer prepare
present print promise prove provide pull push put reach read realize receive remember remove repeat reply report rest
return ride ring rise run save see seem sell send serve set settle share shoot show shut sign sing sit sleep slip smile
sort speak spend stand start stay step stick stop study suggest support suppose take talk teach tell test thank think
throw touch track train travel treat try turn understand update use visit wait wake walk want warn wash watch wear win
wish wonder work worry write
was were did done went gone came made said took taken gave given saw seen knew known thought told found felt left kept
began begun brought bought caught chose chosen drew drawn drove driven ate eaten fell fallen fought flew flown forgot
forgotten grew grown heard held hid hidden hit hurt led lent lay lain lit lost meant met paid put ran rang read rode
ridden rose risen sold sent set shot shut sang sung sat slept spoke spoken spent stood stuck taught tore torn threw
thrown understood woke woken wore worn won wrote written broke broken built burnt dealt dreamt
able bad best better big black blue busy cheap clean clear cold common cool dark dead dear early easy empty fair far
fast fine free fresh full funny glad hard happy heavy high hot huge important interesting kind large last late least
less little long low main major minor nice normal old open other past perfect poor possible quick quiet ready real
recent red right rich safe short sick simple slow small soft sorry special strong sure sweet tall tiny tired top true
usual warm weird white whole wide wild wrong young
again ago ahead almost already always anyway around away back basically certainly definitely done else enough
especially even everywhere exactly finally first maybe never next nothing often once perhaps probably quickly
rather recently right second soon sometimes somewhere still today together tomorrow tonight usually yesterday
anyone anything everyone everything someone something nobody somebody everybody
action answer area article baby bit body book box boy business car case chance child city class company course
day deal door end event eye face fact family father friend game girl group guy hand head home hour house idea
issue job kid kind life line list man meeting message minute mom moment money month morning mother music name
need news night number office paper part party people person phone picture place plan point problem question
reason result room school side sound stuff story student system team thing time today trip way week weekend
woman word work world year yesterday`;

export const COMMON_WORDS = new Set(COMMON.split(/\s+/).filter(Boolean));

export function isCommonWord(w) {
  if (STOPWORDS.has(w) || COMMON_WORDS.has(w)) return true;
  const c = [];
  const stem = (suf) => (w.length > suf.length + 1 && w.endsWith(suf) ? w.slice(0, -suf.length) : null);
  for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'er', 'est', 'ly']) {
    const s = stem(suf);
    if (!s) continue;
    c.push(s, s + 'e');
    if (/([b-df-hj-np-tv-z])\1$/.test(s)) c.push(s.slice(0, -1)); // running -> run
    if (s.endsWith('i')) c.push(s.slice(0, -1) + 'y'); // tried, tries -> try
  }
  return c.some(x => COMMON_WORDS.has(x) || STOPWORDS.has(x));
}
