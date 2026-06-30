/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// LedgerAccount: synthetic chart of accounts master.
	const LedgerAccount = sequelize.define('LedgerAccount', {
		LedgerAccountId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the ledger account.'
		},
		AccountCode: {
			type: DataTypes.STRING(20),
			allowNull: true,
			unique: true,
			comment: 'Synthetic ledger account code.'
		},
		AccountName: {
			type: DataTypes.STRING(120),
			allowNull: true,
			comment: 'Synthetic ledger account display name.'
		}
	}, {
		tableName: 'LedgerAccount',
		timestamps: false,
		freezeTableName: true
	});

	LedgerAccount.associate = (models) => {
		LedgerAccount.hasMany(models.AccountingPosting, { foreignKey: 'LedgerAccountId', as: 'AccountingPostings' });
	};

	return LedgerAccount;
};
