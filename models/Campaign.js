/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// Campaign: synthetic commercial program used for product sales analysis.
	const Campaign = sequelize.define('Campaign', {
		CampaignId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the campaign.'
		},
		CampaignCode: {
			type: DataTypes.STRING(20),
			allowNull: true,
			unique: true,
			comment: 'Synthetic campaign code.'
		},
		CampaignName: {
			type: DataTypes.STRING(120),
			allowNull: true,
			comment: 'Synthetic campaign display name.'
		}
	}, {
		tableName: 'Campaign',
		timestamps: false,
		freezeTableName: true
	});

	Campaign.associate = (models) => {
		Campaign.hasMany(models.Product, { foreignKey: 'CampaignId', as: 'Products' });
		Campaign.hasMany(models.SalesDocument, { foreignKey: 'CampaignId', as: 'SalesDocuments' });
	};

	return Campaign;
};
