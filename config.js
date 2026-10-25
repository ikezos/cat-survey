// 送り先の設定。公開されても困らない値だけを書く(秘密は置かない。クライアントシークレットは使わない)。
// 値を入れるのは公開の時(スコッティ)。空のままだと「送り先が未設定」と出て、保存はできるが送らない。
window.CAT_SURVEY_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzk9jQdz9XG0UzZXWcoOAvjHi7vUxuvIwH1ae0xCpZbPDcu282gpEIvrFapQppXQnhs/exec',         // 受け付け(Apps Script のウェブアプリ)の URL。例: https://script.google.com/macros/s/XXXX/exec
  GOOGLE_CLIENT_ID: '80472958211-3ecba5ngjh2mntsui9mrtnlpefnpu8bi.apps.googleusercontent.com',  // Google Cloud の OAuth クライアント ID。例: 1234567890-abc.apps.googleusercontent.com
  SHOW_DEMO: false,      // true にすると設定に「見本のデータを入れる」ボタンが出る(試す時だけ)。URL に ?demo を付けても出る
};
